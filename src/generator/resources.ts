import toValidIdentifier from "to-valid-identifier";
import { listResources } from "../windmill/resources.js";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";
import { schemaToZod } from "./common.js";
import dedent from "dedent";
import type { Observer } from "./index.js";
import * as path from "node:path";

const resourceToTypeMap = "resourceToType";
const resourceTypesTypeName = "ResourceTypes";

const resourceTransformerName = "_resourcesTransformer";
const defaultResourceTransformerName = "_DefaultResourceTransformer";

const defaultPerResourceTypeMap = "defaultPerResourceType";

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
    do(value: never): unknown;
  }

  export type ApplyTransformer<T extends { new (): Transformer }, Arg> = Awaited<
    ReturnType<(InstanceType<T> & { arg: Arg })["do"]>
  >;

  type GetResourceReturnType<Resource> = Promise<
    ApplyTransformer<typeof ${resourceTransformerName}, Resource>
  >;

  type GetResource = {
    <Path extends keyof typeof ${resourceToTypeMap}>(
      path: Path,
    ): GetResourceReturnType<z.infer<(typeof ${resourceToTypeMap})[Path]["schema"]>>;
    <Type extends keyof ${resourceTypesTypeName}>(
      path: string,
      resourceType: Type,
    ): GetResourceReturnType<${resourceTypesTypeName}[Type]>;
    (path: string, resourceType?: string): Promise<object>;
  };

  export const getResource: GetResource = async (
    path: string,
    resourceType?: string,
  ) => {
    if (${resourceToTypeMap}[path] == null) {
      throw new Error(\`Unknown resource: \${JSON.stringify(path)}\`);
    }
  
    const { name, schema } = ${resourceToTypeMap}[path];
    if (resourceType != null && name !== resourceType) {
      throw new Error(
        \`Unexpected resource type: expected \${JSON.stringify(resourceType)} but resource \${JSON.stringify(path)} has type \${JSON.stringify(name)}\`,
      );
    }

    const data = await wmill.getResource(path);
    const parsedData = schema.parse(data);

    const transformer = ${resourceTransformerName}.prototype.do;

    return transformer.call({ arg: parsedData }, parsedData);
  }

  export const getDefaultResource = <
    T extends keyof typeof defaultPerResourceType,
  >(
    resourceType: T,
  ) => {
    const path = ${defaultPerResourceTypeMap}[resourceType];
    if (path == null) {
      throw new Error(\`No defaults found for resource type \${resourceType}\`);
    }

    return getResource(path);
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

  if (transformerPath && transformerName) {
    await write(
      `import { ${transformerName} as ${resourceTransformerName} } from ${JSON.stringify(`${transformerPath}${transformerExtension}`)};`,
    );
  } else {
    await write(
      `const ${resourceTransformerName} = ${defaultResourceTransformerName};`,
    );
  }

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

  const defaultPerResourceType = new Map<string, string>();

  for (const [resourceTypeName, paths] of resourcesByType) {
    const resourceType = allResourceTypes[resourceTypeName]!;

    const typeSchemaName = resourceTypeSchemaName(resourceType.name);
    const resourceTypeSchema = schemaToZod(resourceType.schema as never, {
      resourceTypeToSchema: resourceTypeSchemaName,
    });

    await write(
      dedent`
        const ${typeSchemaName} = lazyObject(() => ({
          name: ${JSON.stringify(resourceType.name)},
          schema: ${resourceTypeSchema},
        }));
      `,
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

    const defaultPath = getResourceTypeDefault(resourceTypeName, paths);
    if (defaultPath != null) {
      defaultPerResourceType.set(resourceTypeName, defaultPath);
    }
  }

  await write(`const ${resourceToTypeMap} = lazyObject(() => ({`);
  for (const [resourceTypeName, paths] of resourcesByType) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    for (const path of paths) {
      await write(`${JSON.stringify(path)}: ${typeSchemaName},`);
    }
  }
  await write(`} as const));`);

  await write(`export type ${resourceTypesTypeName} = {`);
  for (const resourceTypeName of [...resourcesByType.keys()].toSorted()) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    await write(
      `${JSON.stringify(resourceTypeName)}: z.infer<(typeof ${typeSchemaName})["schema"]>,`,
    );
  }
  await write("}");

  await write(`export const ${defaultPerResourceTypeMap} = {`);
  for (const [
    resourceTypeName,
    defaultPath,
  ] of defaultPerResourceType.entries()) {
    await write(
      `${JSON.stringify(resourceTypeName)}: ${JSON.stringify(defaultPath)},`,
    );
  }
  await write("} as const");

  observer.next("Done");
  observer.complete();
};

export const resourceReferencesSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_references`);

export const resourceTypeSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_type`);

const getResourceTypeDefault = (resourceType: string, paths: string[]) => {
  const { config } = getContext()!;

  return resourceType in config.resources.defaults
    ? config.resources.defaults[resourceType]
    : paths.length === 1
      ? paths[0]
      : null;
};

const makeReferencesSchema = (resourceType: string, paths: string[]) => {
  const refs = paths.map((path) => `$res:${path}`);

  let defaultForType = getResourceTypeDefault(resourceType, refs);
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
