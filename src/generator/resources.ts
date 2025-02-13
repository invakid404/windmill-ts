import toValidIdentifier from "to-valid-identifier";
import { listResources } from "../windmill/resources.js";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";
import { schemaToZod } from "./common.js";
import dedent from "dedent";
import type { Observer } from "./index.js";

const resourceToTypeMap = "resourceToType";

const preamble = dedent`
  export const getResource = async <Path extends keyof typeof ${resourceToTypeMap}>(
    path: Path,
  ): Promise<z.infer<(typeof ${resourceToTypeMap})[Path]>> => {
    const schema = ${resourceToTypeMap}[path];
    const data = await wmill.getResource(path);

    return schema.parse(data);
  }
`;

export const generateResources = async (observer: Observer) => {
  const { write, allResourceTypes } = getContext()!;

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
