import toValidIdentifier from "to-valid-identifier";
import PQueue from "p-queue";
import { listResources } from "../windmill/resources.js";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";
import { schemaToZod } from "./common.js";
import dedent from "dedent";

const resourceToTypeMap = "resourceToType";

const preamble = dedent`
  export const getResource = async <Path extends keyof typeof resourceToType>(
    path: Path,
  ): Promise<z.infer<(typeof resourceToType)[Path]>> => {
    const schema = ${resourceToTypeMap}[path];
    const data = await wmill.getResource(path);

    return schema.parse(data);
  }
`;

export const generateResources = async () => {
  const { write, allResourceTypes } = getContext()!;

  write(preamble);

  const resourcesByType = new Map<string, string[]>();
  for await (const {
    resource_type: resourceTypeName,
    path,
  } of listResources()) {
    const paths = resourcesByType.get(resourceTypeName) ?? [];
    resourcesByType.set(resourceTypeName, [...paths, path]);
  }

  for (const [resourceTypeName, paths] of resourcesByType) {
    const resourceType = allResourceTypes[resourceTypeName]!;

    const typeSchemaName = resourceTypeSchemaName(resourceType.name);
    const resourceTypeSchema = schemaToZod(resourceType.schema as never, {
      resourceTypeToSchemaName: resourceTypeSchemaName,
    });

    write(`const ${typeSchemaName} = lazyObject(() => ${resourceTypeSchema});`);

    const referencesSchemaName = resourceReferencesSchemaName(
      resourceType.name,
    );
    const referencesSchema = schemaToZod(makeReferencesSchema(paths));

    write(
      `const ${referencesSchemaName} = lazyObject(() => ${referencesSchema});`,
    );
  }

  write(`const ${resourceToTypeMap} = lazyObject(() => ({`);
  for (const [resourceTypeName, paths] of resourcesByType) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    for (const path of paths) {
      write(`${JSON.stringify(path)}: ${typeSchemaName},`);
    }
  }
  write(`} as const));`);
};

export const resourceReferencesSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_references`);

export const resourceTypeSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_type`);

const makeReferencesSchema = (paths: string[]) => {
  const refs = paths.map((path) => `$res:${path}`);

  return {
    type: "string",
    enum: refs,
    ...(refs.length === 1 && { default: refs[0] }),
  } satisfies JSONSchema;
};
