import toValidIdentifier from "to-valid-identifier";
import { listResources } from "../windmill/resources.js";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";
import { schemaToZod } from "./common.js";
import dedent from "dedent";
import type { Observer } from "./index.js";
import * as path from "node:path";

const resourceToTypeMap = "resourceToType";

const resourceTransformerName = "_resourcesTransformer";
const defaultResourceTransformerName = "_DefaultResourceTransformer";

const defaultResourceTransformer = dedent`
  class ${defaultResourceTransformerName} implements Transformer {
    arg: unknown
    do(value: Cast<(typeof this)["arg"], object>) {
      return value;
    }
  }
`;

const preamble = dedent`
  export type Cast<T, U> = T extends U ? T : U;

  export interface Transformer {
    arg: unknown;
    do(value: (typeof this)["arg"]): unknown;
  }

  export type ApplyTransformer<
    T extends { new (): Transformer },
    Arg,
  > = ReturnType<(InstanceType<T> & { arg: Arg })["do"]>;

  export const getResource = async <Path extends keyof typeof ${resourceToTypeMap}>(
    path: Path,
  ) => {
    const schema = ${resourceToTypeMap}[path];
    const data = await wmill.getResource(path);
    const parsedData = schema.parse(data);

    const transformer = ${resourceTransformerName}.prototype.do;

    return transformer.call({ arg: parsedData }, parsedData) as z.infer<
      (typeof ${resourceToTypeMap})[Path]
    > extends infer Resource
      ? ApplyTransformer<typeof ${resourceTransformerName}, Resource>
      : never;
  }
`;

export const generateResources = async (observer: Observer) => {
  const { write, allResourceTypes, config, outputDir } = getContext()!;

  let transformerPath = config.resources.transformer?.importPath;
  let transformerName = config.resources.transformer?.importName;
  const transformerExtension = config.resources.transformer?.importExtension;
  if (!transformerPath || !transformerName) {
    transformerName = defaultResourceTransformerName;
    transformerPath = "";

    await write(defaultResourceTransformer);
  }

  if (transformerPath) {
    // Resolve path relative to config dir
    const configDir = config.configPath
      ? path.dirname(config.configPath)
      : process.cwd();

    transformerPath = path.resolve(configDir, transformerPath);

    // Get relative path in relation to output dir
    transformerPath = path.relative(outputDir, transformerPath);
    if (
      !transformerPath.startsWith("./") &&
      !transformerPath.startsWith("../")
    ) {
      transformerPath = `./${transformerPath}`;
    }

    // Strip extension
    const extension = path.extname(transformerPath);
    transformerPath = transformerPath.slice(0, -extension.length);
  }

  let resourcesTransformerAlias = `const ${resourceTransformerName} = `;
  if (transformerPath) {
    resourcesTransformerAlias += `(await import(${JSON.stringify(`${transformerPath}${transformerExtension || ""}`)})).`;
  }
  resourcesTransformerAlias += `${transformerName};`;

  await write(resourcesTransformerAlias);
  await write(preamble);

  observer.next("Fetching all resources...");
  const resourcesByType = new Map<string, string[]>();
  for await (const {
    resource_type: resourceTypeName,
    path,
  } of listResources()) {
    if (!(resourceTypeName in allResourceTypes)) {
      continue;
    }

    const paths = resourcesByType.get(resourceTypeName) ?? [];
    resourcesByType.set(resourceTypeName, [...paths, path]);
  }

  observer.next("Generating schemas...");
  for (const [resourceTypeName, paths] of resourcesByType) {
    const resourceType = allResourceTypes[resourceTypeName]!;

    const typeSchemaName = resourceTypeSchemaName(resourceType.name);
    const resourceTypeSchema = schemaToZod(resourceType.schema as never, {
      resourceTypeToSchema: resourceTypeSchemaName,
    });

    await write(
      `const ${typeSchemaName} = lazyObject(() => ${resourceTypeSchema});`,
    );

    const referencesSchemaName = resourceReferencesSchemaName(
      resourceType.name,
    );
    const referencesSchema = schemaToZod(
      makeReferencesSchema(resourceType.name, paths),
    );

    await write(
      `const ${referencesSchemaName} = lazyObject(() => ${referencesSchema});`,
    );
  }

  await write(`const ${resourceToTypeMap} = lazyObject(() => ({`);
  for (const [resourceTypeName, paths] of resourcesByType) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    for (const path of paths) {
      await write(`${JSON.stringify(path)}: ${typeSchemaName},`);
    }
  }
  await write(`} as const));`);

  await write("export type ResourceTypes = {");
  for (const resourceTypeName of [...resourcesByType.keys()].toSorted()) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    await write(
      `${JSON.stringify(resourceTypeName)}: z.infer<typeof ${typeSchemaName}>,`,
    );
  }
  await write("}");

  observer.next("Done");
  observer.complete();
};

export const resourceReferencesSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_references`);

export const resourceTypeSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_type`);

const makeReferencesSchema = (resourceType: string, paths: string[]) => {
  const { config } = getContext()!;

  const refs = paths.map((path) => `$res:${path}`);

  let defaultForType =
    resourceType in config.resources.defaults
      ? config.resources.defaults[resourceType]
      : refs.length === 1
        ? refs[0]
        : undefined;

  if (defaultForType != null && !defaultForType.startsWith("$res:")) {
    defaultForType = `$res:${defaultForType}`;
  }

  if (defaultForType != null && !refs.includes(defaultForType)) {
    throw new Error(
      `Default for resource type ${resourceType} is not valid: ${defaultForType} not found in resources`,
    );
  }

  return {
    type: "string",
    enum: refs,
    ...(defaultForType != null && { default: defaultForType }),
  } satisfies JSONSchema;
};
