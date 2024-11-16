import dedent from "dedent";
import { extractResourceTypeFromSchema } from "./generator/extractResourceTypeFromSchema.js";
import { makeResourceSchema } from "./generator/makeResourceSchema.js";
import { setup } from "./windmill/client.js";
import { listResourcesByType } from "./windmill/resources.js";
import { listResourceTypes } from "./windmill/resourceTypes.js";
import { listScripts } from "./windmill/scripts.js";
import { getActiveWorkspace } from "./windmill/workspace.js";
import { jsonSchemaToZod } from "json-schema-to-zod";
import toValidIdentifier from "to-valid-identifier";
import PQueue from "p-queue";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

const allResourceTypes = await listResourceTypes();
const referencedResourceTypes = new Set<string>();

console.log(dedent`
  import { z } from 'zod';
  import * as wmill from 'windmill-client';

  const lazyObject = <T,>(fn: () => T) => {
    let instance: T | null = null;
    return new Proxy({}, {
      get(_target, prop) {
        if (instance == null) {
          instance = fn();
        }

        return instance[prop];
      }
    }) as T;
  }

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
`);

const scriptMap = new Map<string, string>();

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

  console.log(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
  scriptMap.set(path, schemaName);
}

const resourceQueue = new PQueue({ concurrency: 5 });

const resources = [...referencedResourceTypes].map((resourceType) =>
  resourceQueue.add(
    async () => ({
      resourceType,
      paths: await Array.fromAsync(
        listResourcesByType(resourceType),
        ({ path }) => path,
      ),
    }),
    { throwOnTimeout: true },
  ),
);

for await (const { resourceType, paths } of resources) {
  const resourceSchema = makeResourceSchema(paths);

  const schemaName = toValidIdentifier(resourceType);
  const zodSchema = jsonSchemaToZod(resourceSchema);

  console.log(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
}

console.log("const scripts = lazyObject(() => ({");
for (const [scriptPath, schemaName] of scriptMap) {
  console.log(`${JSON.stringify(scriptPath)}: ${schemaName},`);
}
console.log("} as const))");
