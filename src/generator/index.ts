import { Writable } from "node:stream";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";

export const generate = async (output: Writable) =>
  run(output, async () => {
    writePreamble();

    const allResourceTypes = await listResourceTypes();
    const results = await Promise.all(
      [generateScripts, generateFlows].map((fn) =>
        runWithBuffer(() => fn(allResourceTypes)),
      ),
    );

    const referencedResourceTypes = results.reduce(
      (acc, { buffer, result }) => {
        buffer.pipe(output);

        return acc.union(result);
      },
      new Set<string>(),
    );

    await generateResources([...referencedResourceTypes]);
  });
