import { setup } from "./windmill/client.js";
import { getActiveWorkspace } from "./windmill/workspace.js";
import { generate } from "./generator/index.js";

const activeWorkspace = await getActiveWorkspace();
if (activeWorkspace == null) {
  throw new Error("Windmill CLI not configured");
}

setup(activeWorkspace);

await generate(process.stdout);
