import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";
import { runTasks, type Observer } from "./taskRunner.js";
import { Config, getConfig } from "../config/index.js";

export type { Observer };

export type GenerateOptions = {
  spinners?: boolean;
};

type Task = {
  runner: (observer: Observer) => Promise<void>;
  isEnabled: (config: Config) => boolean;
};

const subtasks = {
  "Generate resources": {
    runner: generateResources,
    isEnabled: () => true,
  },
  "Generate scripts": {
    runner: generateScripts,
    isEnabled: (config) => config.scripts.enabled,
  },
  "Generate flows": {
    runner: generateFlows,
    isEnabled: (config) => config.flows.enabled,
  },
} as const satisfies Record<string, Task>;

export const generate = async (
  output: Writable,
  outputDir: string,
  options?: GenerateOptions,
) => {
  const { spinners = false } = options ?? {};

  const config = await getConfig();

  const allResourceTypes = await listResourceTypes();

  return run(output, outputDir, allResourceTypes, async () => {
    await writePreamble();

    const results = (
      await runTasks(
        Object.entries(subtasks).map(([name, task]) => ({
          title: name,
          task: (observer: Observer) =>
            runWithBuffer(() => task.runner(observer)),
          enabled: !config || task.isEnabled(config),
        })),
        { silent: !spinners },
      )
    ).filter((result) => result != null);

    for (const { buffer } of results) {
      await pipeline(buffer, output, { end: false });
    }
  });
};
