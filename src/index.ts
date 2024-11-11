import { collectResourceTypes } from "./generator/collectResourceTypes.js";
import { setup } from "./windmill/client.js";
import { listResourceTypes } from "./windmill/resourceTypes.js";
import { listScripts } from "./windmill/scripts.js";
import { getActiveWorkspace } from "./windmill/workspace.js";

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

console.log(referencedResourceTypes);
