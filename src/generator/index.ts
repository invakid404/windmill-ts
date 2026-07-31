import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import type { GenerationSource, ResourceTypes } from "../source/types.js";
import { collectWorkspaceResources } from "../source/resources.js";
import { remoteSource } from "../source/remote.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";
import { runTasks, type Observer } from "./taskRunner.js";
import { Config, getConfig } from "../config/index.js";

export type { Observer };

export type GenerateOptions = {
  spinners?: boolean;
  /** The data source to generate from. Defaults to the remote HTTP provider. */
  source?: GenerationSource;
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
  const { spinners = false, source = remoteSource } = options ?? {};

  const config = await getConfig();

  const allResourceTypes = await source.listResourceTypes();
  const workspaceResources = await collectWorkspaceResources(
    source,
    allResourceTypes,
  );

  // NOTE: schemas are only emitted for resource types that have at least one
  //       resource in the workspace, so those are the only ones the generated
  //       code can refer to. Narrowing the set here (instead of passing every
  //       resource type known to the instance) keeps what we generate and what
  //       we reference in sync, and makes anything else fall back to `z.any()`
  const resourceTypes: ResourceTypes = new Map(
    [...workspaceResources.resourcesByType.keys()].map((resourceTypeName) => [
      resourceTypeName,
      allResourceTypes.get(resourceTypeName)!,
    ]),
  );

  const shared = { outputDir, resourceTypes, workspaceResources, source };

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
