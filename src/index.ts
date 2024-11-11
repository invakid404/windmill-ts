import { setup } from "./windmill/client.js";
import { listResourceTypes } from "./windmill/resourceTypes.js";
import { listScripts } from "./windmill/scripts.js";
import { getActiveWorkspace } from "./windmill/workspace.js";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

console.log(await listResourceTypes());

for await (const { path, schema } of listScripts()) {
  console.log(path, JSON.stringify(schema, null, 2));
}
