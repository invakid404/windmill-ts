import { setup } from "./windmill/client.js";
import { getActiveWorkspace } from "./windmill/workspace.js";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);
