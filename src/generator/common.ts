import toValidIdentifier from "to-valid-identifier";
import { jsonSchemaToZod } from "json-schema-to-zod";
import { getContext, run } from "./context.js";
import { JSONSchema } from "./types.js";
import { PassThrough } from "node:stream";
import {
  resourceReferencesSchemaName,
  resourceTypeSchemaName,
} from "./resources.js";
import { once } from "../utils/once.js";
import dedent from "dedent";
import type { Observer } from "./index.js";
import { fixupZodSchema } from "../utils/fixupZodSchema.js";

export const runWithBuffer = async <T,>(cb: () => T) => {
  const { allResourceTypes, outputDir } = getContext()!;

  const buffer = new PassThrough({
    // The default limit appears to cause writes to start failing when too
    // many resources of a given type exist; this should be high enough
    highWaterMark: 1024 * 1024,
  });
  const result = await run(buffer, outputDir, allResourceTypes, cb);

  return { buffer, result };
};

export type ResourceWithSchema = {
  path: string;
  schema?: JSONSchema;
};

export type GenerateSchemasOptions = {
  generator: AsyncGenerator<ResourceWithSchema>;
  mapName: string;
  observer: Observer;
  looseArgs?: boolean;
};

export const generateSchemas = async ({
  generator,
  mapName,
  observer,
  looseArgs = false,
}: GenerateSchemasOptions) => {
  const { write } = getContext()!;

  try {
    const pathToSchemaMap = new Map<string, string>();

    observer.next("Fetching resources...");
    for await (const { path, schema } of generator) {
      if (schema == null) {
        continue;
      }

      const schemaName = toValidIdentifier(`${mapName}_${path}`);
      const zodSchema = schemaToZod(schema, { looseTopLevelObject: looseArgs });

      await write(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
      pathToSchemaMap.set(path, schemaName);
    }

    observer.next("Generating schemas...");
    await write(`const ${mapName} = lazyObject(() => ({`);
    for (const [scriptPath, schemaName] of pathToSchemaMap) {
      await write(`${JSON.stringify(scriptPath)}: ${schemaName},`);
    }
    await write("} as const))");

    observer.next("Done");
  } catch (err) {
    observer.error(err);
  } finally {
    observer.complete();
  }
};

export type SchemaToZodOptions = {
  resourceTypeToSchema?: (resourceType: string) => string;
  looseTopLevelObject?: boolean;
};

export const schemaToZod = (
  schema: JSONSchema,
  options?: SchemaToZodOptions,
) => {
  const {
    resourceTypeToSchema = resourceTypeToUnion,
    looseTopLevelObject = false,
  } = options ?? {};
  const { allResourceTypes } = getContext()!;

  let result = jsonSchemaToZod(schema, {
    parserOverride: (schema, _refs) => {
      // NOTE: Windmill sometimes has `default: null` on required fields,
      //       which is incorrect for obvious reasons, so as a rule of thumb,
      //       we remove null default values as a whole
      if ("default" in schema && schema.default == null) {
        delete schema.default;
      }

      // NOTE: Windmill sometimes has invalid default values on enum schemas,
      //       which causes the generated code to error during compilation
      if (
        schema.enum != null &&
        "default" in schema &&
        !schema.enum.includes(schema.default)
      ) {
        delete schema.default;
      }

      // NOTE: Windmill sometimes has `enum: null` on string fields, and the
      //       library doesn't like that, so we need to delete it
      if (schema.type === "string" && schema.enum == null) {
        delete schema.enum;
      }

      if (
        schema.type === "string" &&
        "contentEncoding" in schema &&
        schema.contentEncoding === "base64"
      ) {
        return base64FileZodSchema();
      }

      if (
        schema.type === "object" &&
        (schema.properties == null ||
          Object.keys(schema.properties).length === 0)
      ) {
        schema.additionalProperties = true;
      }

      // Map dynamic enums back to their original type
      if (schema.type === "object" && schema.format?.startsWith("dynselect-")) {
        const originalType =
          "originalType" in schema &&
          typeof schema.originalType === "string" &&
          schema.originalType;

        if (originalType) {
          schema.type = originalType;
        } else {
          // If no original type in the schema, we cannot infer anything, so
          // we must mark it as `any` by deleting its type
          delete schema.type;
        }
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

        return resourceTypeToSchema(resourceType);
      }
    },
  });

  return fixupZodSchema(result, { looseTopLevelObject });
};

const resourceTypeToUnion = (resourceType: string) => {
  return `z.union([${resourceReferencesSchemaName(resourceType)}, ${resourceTypeSchemaName(resourceType)}.schema])`;
};

const base64FileZodSchema = once(() => {
  const { deferWrite } = getContext()!;
  const name = `$base64_file_type`;

  const schema = dedent`
    z.union([
      z.string().base64(),
      z.string().refine(
        (value) => {
          const base64Match = value.match(/^data:(.*?);base64,(.+)$/);
          if (!base64Match) {
            return false;
          }
          const [, mimeType, data] = base64Match;
          if (!mimeType) {
            return false;
          }
          return z.string().base64().safeParse(data).success;
        },
      ),
    ])
  `;
  deferWrite(`const ${name} = ${schema};`);

  return name;
});

const s3ObjectZodSchema = once(() => {
  const { deferWrite } = getContext()!;
  const name = `S3ObjectSchema`;

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

  const schema = jsonSchemaToZod(jsonSchema);
  deferWrite(`export const ${name} = ${schema};`);

  return name;
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
