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
import camelCase from "lodash.camelcase";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

// TODO: handle all invalid characters in TypeScript identifiers
const scriptPathToSchemaName = (scriptPath: string) =>
  scriptPath.replaceAll("/", "_").replaceAll("-", "_");

const resourceTypeToSchemaName = (resourceType: string) =>
  camelCase(resourceType);

const allResourceTypes = await listResourceTypes();

const referencedResourceTypes = new Set<string>();
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

  // TODO: handle non-resource argument types outside of main signature
  const zodSchema = jsonSchemaToZod(schema, {
    name: scriptPathToSchemaName(path),
    module: "esm",
    type: true,
    noImport: true,
    parserOverride: (schema, refs) => {
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

        return resourceTypeToSchemaName(resourceType);
      }
    },
  });

  console.log(zodSchema);
}

for (const resourceType of referencedResourceTypes) {
  const resourcePaths = await Array.fromAsync(
    listResourcesByType(resourceType),
    ({ path }) => path,
  );

  const resourceSchema = makeResourceSchema(resourceType, resourcePaths);
  const zodSchema = jsonSchemaToZod(resourceSchema, {
    name: resourceTypeToSchemaName(resourceType),
    module: "esm",
    type: true,
    noImport: true,
  });

  console.log(zodSchema);
}
