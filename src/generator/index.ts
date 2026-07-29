import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import {
  listResourceTypes,
  type ResourceTypes,
} from "../windmill/resourceTypes.js";
import { collectWorkspaceResources } from "../windmill/resources.js";
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
  const workspaceResources = await collectWorkspaceResources(allResourceTypes);

  // NOTE: schemas are only emitted for resource types that have at least one
  //       resource in the workspace, so those are the only ones the generated
  //       code can refer to. Narrowing the set here (instead of passing every
  //       resource type known to the instance) keeps what we generate and what
  //       we reference in sync, and makes anything else fall back to `z.any()`
  const resourceTypes: ResourceTypes = Object.fromEntries(
    [...workspaceResources.resourcesByType.keys()].map((resourceTypeName) => [
      resourceTypeName,
      allResourceTypes[resourceTypeName]!,
    ]),
  );

  const shared = { outputDir, resourceTypes, workspaceResources };

  return run(output, shared, async () => {
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
