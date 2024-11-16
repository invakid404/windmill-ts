import { Writable } from "node:stream";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";

export const generate = async (output: Writable) =>
  run(output, async () => {
    writePreamble();

    const allResourceTypes = await listResourceTypes();

    const referencedResourceTypes = await generateScripts(allResourceTypes);
    await generateResources([...referencedResourceTypes]);
  });
