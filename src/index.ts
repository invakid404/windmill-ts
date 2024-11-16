import { collectResourceTypes } from "./generator/collectResourceTypes.js";
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

const allResourceTypes = await listResourceTypes();

const referencedResourceTypes = new Set<string>();
for await (const { schema } of listScripts()) {
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
}

for (const resourceType of referencedResourceTypes) {
  const resourcePaths = await Array.fromAsync(
    listResourcesByType(resourceType),
    ({ path }) => path,
  );

  const resourceSchema = makeResourceSchema(resourceType, resourcePaths);
  const zodSchema = jsonSchemaToZod(resourceSchema, {
    name: camelCase(resourceType),
    module: "esm",
    type: true,
    noImport: true,
  });

  console.log(zodSchema);
}
