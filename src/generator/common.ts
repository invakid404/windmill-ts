import toValidIdentifier from "to-valid-identifier";
import { jsonSchemaToZod } from "json-schema-to-zod";
import { getContext, run } from "./context.js";
import { JSONSchema } from "./types.js";
import { InMemoryDuplex } from "../utils/inMemoryDuplex.js";
import { resourceReferencesSchemaName } from "./resources.js";
import { once } from "../utils/once.js";

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
  const { write } = getContext()!;

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
        // NOTE: this is exactly how the Windmill frontend detects S3 objects
        //       it is needed, as both `S3Object` and `s3_object` are valid
        //       https://github.com/windmill-labs/windmill/blob/e4583e9b2366b90f31eb015c4dfc21f07b0bc31e/frontend/src/lib/components/ArgInput.svelte#L604-L607
        if (resourceType.replace("_", "").toLowerCase() === "s3object") {
          return s3ObjectZodSchema();
        }

        // NOTE: we could do a best-effort attempt to resolve non-resource
        //       argument types by parsing the script sources (for TS only),
        //       but handling things like types imported from elsewhere would
        //       not be easy
        if (!(resourceType in allResourceTypes)) {
          return "z.any()";
        }

        return resourceTypeToSchemaName(resourceType);
      }
    },
  });
};

const s3ObjectZodSchema = once(() => {
  const jsonSchema = {
    type: "object",
    properties: {
      s3: {
        type: "string",
      },
      storage: {
        type: "string",
      },
      // NOTE: `filename` isn't present in `S3Object` in `windmill-client`, but
      //       Windmill sets it when you upload a file from the UI
      filename: {
        type: "string",
      },
    },
    required: ["s3"],
  } satisfies JSONSchema;

  return jsonSchemaToZod(jsonSchema);
});

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
