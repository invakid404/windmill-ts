import { Project, ScriptTarget, SyntaxKind, Node } from "ts-morph";

// NOTE: this is a hack to support Zod v4 until there is official support
export const fixupZodSchema = (generatedSchema: string) => {
  const sourceFile = tsCodeToSourceFile(generatedSchema);

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
