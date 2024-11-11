import { setup } from "./windmill/client.js";
import { listScripts } from "./windmill/scripts.js";
import { getActiveWorkspace } from "./windmill/workspace.js";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

for await (const { path, schema } of listScripts()) {
  console.log(path, JSON.stringify(schema, null, 2));
}
