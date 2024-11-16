import dedent from "dedent";
import {
  collectResourceTypes,
  extractResourceTypeFromSchema,
} from "./generator/collectResourceTypes.js";
import { makeResourceSchema } from "./generator/makeResourceSchema.js";
import { setup } from "./windmill/client.js";
import { listResourcesByType } from "./windmill/resources.js";
import { listResourceTypes } from "./windmill/resourceTypes.js";
import { listScripts } from "./windmill/scripts.js";
import { getActiveWorkspace } from "./windmill/workspace.js";
import { jsonSchemaToZod } from "json-schema-to-zod";
import toValidIdentifier from "to-valid-identifier";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

const allResourceTypes = await listResourceTypes();
const referencedResourceTypes = new Set<string>();

console.log(dedent`
  import { z } from 'zod';

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
`);

for await (const { path, schema } of listScripts()) {
  if (schema == null) {
    continue;
  }

  const resourceTypes = collectResourceTypes(schema);
  for (const resourceType of resourceTypes) {
    if (!(resourceType in allResourceTypes)) {
      continue;
    }

    referencedResourceTypes.add(resourceType);
  }

  const schemaName = toValidIdentifier(path);
  const zodSchema = jsonSchemaToZod(schema, {
    parserOverride: (schema, refs) => {
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

        return toValidIdentifier(resourceType);
      }
    },
  });

  console.log(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
}

for (const resourceType of referencedResourceTypes) {
  const resourcePaths = await Array.fromAsync(
    listResourcesByType(resourceType),
    ({ path }) => path,
  );

  const resourceSchema = makeResourceSchema(resourceType, resourcePaths);

  const schemaName = toValidIdentifier(resourceType);
  const zodSchema = jsonSchemaToZod(resourceSchema);

  console.log(`const ${schemaName} = lazyObject(() => ${zodSchema});`);
}
