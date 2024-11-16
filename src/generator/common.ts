import toValidIdentifier from "to-valid-identifier";
import { jsonSchemaToZod } from "json-schema-to-zod";
import { getContext, run } from "./context.js";
import { JSONSchema } from "./types.js";
import { InMemoryDuplex } from "../utils/inMemoryDuplex.js";
import { resourceReferencesSchemaName } from "./resources.js";

export const runWithBuffer = async <T,>(cb: () => T) => {
  const { allResourceTypes } = getContext()!;

  const buffer = new InMemoryDuplex();
  const result = await run(buffer, allResourceTypes, cb);

  return { buffer, result };
};

export type ResourceWithSchema = {
  path: string;
  schema?: JSONSchema;
};

export type GenerateSchemasOptions = {
  generator: AsyncGenerator<ResourceWithSchema>;
  mapName: string;
};

export const generateSchemas = async ({
  generator,
  mapName,
}: GenerateSchemasOptions) => {
  const { write, allResourceTypes } = getContext()!;

  const pathToSchemaMap = new Map<string, string>();

  for await (const { path, schema } of generator) {
    if (schema == null) {
      continue;
    }

    const schemaName = toValidIdentifier(`${mapName}_${path}`);
    const zodSchema = schemaToZod(schema);

    write(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
    pathToSchemaMap.set(path, schemaName);
  }

  write(`const ${mapName} = lazyObject(() => ({`);
  for (const [scriptPath, schemaName] of pathToSchemaMap) {
    write(`${JSON.stringify(scriptPath)}: ${schemaName},`);
  }
  write("} as const))");
};

export type SchemaToZodOptions = {
  resourceTypeToSchemaName?: (resourceType: string) => string;
};

export const schemaToZod = (
  schema: JSONSchema,
  options?: SchemaToZodOptions,
) => {
  const { resourceTypeToSchemaName = resourceReferencesSchemaName } =
    options ?? {};
  const { allResourceTypes } = getContext()!;

  return jsonSchemaToZod(schema, {
    parserOverride: (schema, _refs) => {
      // NOTE: Windmill sometimes has `default: null` on required fields,
      //       which is incorrect for obvious reasons, so as a rule of thumb,
      //       we remove null default values as a whole
      if ("default" in schema && schema.default == null) {
        delete schema.default;
      }

      // NOTE: Windmill sometimes has `enum: null` on string fields, and the
      //       library doesn't like that, so we need to delete it
      if (schema.type === "string" && schema.enum == null) {
        delete schema.enum;

        return;
      }

      const resourceTypeOrFalse = extractResourceTypeFromSchema(
        schema as never,
      );
      if (resourceTypeOrFalse) {
        const { resourceType } = resourceTypeOrFalse;
        // NOTE: we could do a best-effort attempt to resolve non-resource
        //       argument types by parsing the script sources (for TS only),
        //       but handling things like types imported from elsewhere would
        //       not be easy
        if (!(resourceType in allResourceTypes)) {
          return `z.any()`;
        }

        return resourceTypeToSchemaName(resourceType);
      }
    },
  });
};

const RESOURCE_TYPE_PREFIX = "resource-";

const extractResourceTypeFromSchema = (schema: JSONSchema) => {
  if (
    schema.type !== "object" ||
    !schema.format?.startsWith(RESOURCE_TYPE_PREFIX)
  ) {
    return false;
  }

  return {
    resourceType: schema.format.slice(RESOURCE_TYPE_PREFIX.length),
  };
};
