import {
  Project,
  ScriptTarget,
  SyntaxKind,
  Node,
  type SourceFile,
} from "ts-morph";

type FixupOptions = {
  looseTopLevelObject?: boolean;
};

// NOTE: this is a hack to support Zod v4 until there is official support
export const fixupZodSchema = (
  generatedSchema: string,
  options?: FixupOptions,
) => {
  const { looseTopLevelObject = false } = options ?? {};
  const sourceFile = tsCodeToSourceFile(generatedSchema);

  if (looseTopLevelObject) {
    makeTopLevelObjectLoose(sourceFile);
  }

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() === SyntaxKind.CallExpression) {
      const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
      const propertyExpr = callExpr.getExpressionIfKind(
        SyntaxKind.PropertyAccessExpression,
      );

      if (propertyExpr) {
        const methodName = propertyExpr.getName();

        // Replace .default() with .prefault()
        if (methodName === "default") {
          propertyExpr.getNameNode().replaceWithText("prefault");
        }
        // Handle `.record()` calls without a key
        else if (
          methodName === "record" &&
          callExpr.getArguments().length === 1
        ) {
          callExpr.insertArgument(0, "z.string()");
        }
        // Handle deprecated `ctx.addIssue()` in `.superRefine()`
        else if (
          methodName === "addIssue" &&
          callExpr.getArguments().length === 1
        ) {
          const receiverName = propertyExpr.getExpression().getText();

          const arg = callExpr.getArguments()[0];
          const objLit = arg.asKind(SyntaxKind.ObjectLiteralExpression);
          if (!objLit) {
            return;
          }

          const codeProp = objLit.getProperty("code");
          const unionErrorsProp = objLit.getProperty("unionErrors");

          // Check if `code` is what we expect
          if (
            !codeProp ||
            !Node.isPropertyAssignment(codeProp) ||
            codeProp
              .getInitializerIfKind(SyntaxKind.StringLiteral)
              ?.getLiteralValue() !== "invalid_union"
          ) {
            return;
          }

          // Ensure `unionErrors` is what we expect
          if (
            !unionErrorsProp ||
            (!Node.isPropertyAssignment(unionErrorsProp) &&
              !Node.isShorthandPropertyAssignment(unionErrorsProp))
          ) {
            return;
          }

          // Remove path prop if present
          objLit.getProperty("path")?.remove();

          // Replace `unionErrors` with `errors` and transform
          const originalErrorsText = unionErrorsProp
            .getInitializer()
            ?.getText();
          if (!originalErrorsText) {
            throw new Error(
              "`unionErrors` has no initializer, this should never happen",
            );
          }

          unionErrorsProp.remove();

          objLit.addPropertyAssignment({
            name: "errors",
            initializer: `${originalErrorsText}.map(error => error._zod.def)`,
          });

          // Add `input` property
          objLit.addPropertyAssignment({
            name: "input",
            initializer: `${receiverName}.value`,
          });
        }
      }
    }
  });

  return sourceFile.getFullText();
};

const tsCodeToSourceFile = (tsCode: string) => {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2020,
    },
  });

  return project.createSourceFile("source.ts", tsCode);
};

const makeTopLevelObjectLoose = (sourceFile: SourceFile) => {
  const expressionStatement = sourceFile
    .getStatements()
    .find((statement) => statement.isKind(SyntaxKind.ExpressionStatement))
    ?.asKind(SyntaxKind.ExpressionStatement);

  if (!expressionStatement) {
    return;
  }

  replaceZObjectInChain(expressionStatement.getExpression());
};

const replaceZObjectInChain = (node: Node | undefined): boolean => {
  if (!node) {
    return false;
  }

  if (Node.isParenthesizedExpression(node)) {
    return replaceZObjectInChain(node.getExpression());
  }

  if (Node.isCallExpression(node)) {
    return replaceZObjectInChain(node.getExpression());
  }

  if (Node.isPropertyAccessExpression(node)) {
    const expression = node.getExpression();

    if (Node.isIdentifier(expression) && expression.getText() === "z") {
      if (node.getName() === "object") {
        node.getNameNode().replaceWithText("looseObject");
        return true;
      }

      return false;
    }

    return replaceZObjectInChain(expression);
  }

  return false;
};
