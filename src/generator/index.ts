import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";
import { Listr } from "listr2";
import { Observable, Subscriber } from "rxjs";
import { Config, getConfig } from "../config/index.js";

export type Observer = Subscriber<string>;

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

type ListrContext = {
  results: Array<ReturnType<typeof runWithBuffer>>;
};

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

    const tasks = new Listr(
      Object.entries(subtasks).map(([name, task], idx) => {
        return {
          title: name,
          task: (ctx: ListrContext) =>
            new Observable((subscriber) => {
              ctx.results ??= [];
              ctx.results[idx] = runWithBuffer(() => task.runner(subscriber));
            }),
          enabled: !config || task.isEnabled(config),
          rendererOptions: {
            persistentOutput: true,
          },
        };
      }),
      { concurrent: true, renderer: spinners ? "default" : "silent" },
    );

    const ctx = await tasks.run();
    const results = await Promise.all(ctx.results).then((results) =>
      results.filter((result) => result != null),
    );

    for (const { buffer } of results) {
      await pipeline(buffer, output, { end: false });
    }
  });
};
