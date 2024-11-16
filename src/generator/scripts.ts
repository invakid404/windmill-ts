import { listScripts } from "../windmill/scripts.js";
import toValidIdentifier from "to-valid-identifier";
import { jsonSchemaToZod } from "json-schema-to-zod";
import type { ResourceTypes } from "../windmill/resourceTypes.js";
import { getContext } from "./context.js";
import dedent from "dedent";
import { JSONSchema } from "./types.js";

const preamble = dedent`  
  export const runScript = <Path extends keyof typeof scripts>(
    scriptPath: Path,
    args: z.input<(typeof scripts)[Path]>,
  ) => {
    const schema = scripts[scriptPath];

    return wmill.runScript(scriptPath, null, schema.parse(args));
  };

  export const runScriptAsync = <Path extends keyof typeof scripts>(
    scriptPath: Path,
    args: z.input<(typeof scripts)[Path]>,
  ) => {
    const schema = scripts[scriptPath];

    return wmill.runScriptAsync(scriptPath, null, schema.parse(args));
  };
`;

export const generateScripts = async (allResourceTypes: ResourceTypes) => {
  const { write } = getContext()!;

  await write(preamble);

  const scriptMap = new Map<string, string>();
  const referencedResourceTypes = new Set<string>();

  for await (const { path, schema } of listScripts()) {
    if (schema == null) {
      continue;
    }

    const schemaName = toValidIdentifier(path);
    const zodSchema = jsonSchemaToZod(schema, {
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

          referencedResourceTypes.add(resourceType);

          return toValidIdentifier(resourceType);
        }
      },
    });

    write(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
    scriptMap.set(path, schemaName);
  }

  write("const scripts = lazyObject(() => ({");
  for (const [scriptPath, schemaName] of scriptMap) {
    write(`${JSON.stringify(scriptPath)}: ${schemaName},`);
  }
  write("} as const))");

  return referencedResourceTypes;
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
