import { Writable } from "node:stream";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";

export const generate = async (output: Writable) => {
  const allResourceTypes = await listResourceTypes();

  return run(output, allResourceTypes, async () => {
    await writePreamble();

    const results = await Promise.all(
      [generateResources, generateScripts, generateFlows].map((fn) =>
        runWithBuffer(fn),
      ),
    );

    results.forEach(({ buffer }) => {
      buffer.pipe(output);
    });
  });
};
