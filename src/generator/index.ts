import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writePreamble } from "./preamble.js";
import { run } from "./context.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import { generateScripts } from "./scripts.js";
import { generateResources } from "./resources.js";
import { generateFlows } from "./flows.js";
import { runWithBuffer } from "./common.js";
import { Listr, SilentRenderer } from "listr2";
import { Observable, Subscriber } from "rxjs";

export type Observer = Subscriber<string>;

export type GenerateOptions = {
  spinners?: boolean;
};

const subtasks = {
  "Generate resources": generateResources,
  "Generate scripts": generateScripts,
  "Generate flows": generateFlows,
} as const satisfies Record<string, (observer: Observer) => Promise<void>>;

type ListrContext = {
  results: Array<ReturnType<typeof runWithBuffer>>;
};

export const generate = async (output: Writable, options?: GenerateOptions) => {
  const { spinners = false } = options ?? {};

  const allResourceTypes = await listResourceTypes();

  return run(output, allResourceTypes, async () => {
    await writePreamble();

    const tasks = new Listr(
      Object.entries(subtasks).map(([name, fn], idx) => {
        return {
          title: name,
          task: (ctx: ListrContext) =>
            new Observable((subscriber) => {
              ctx.results ??= [];
              ctx.results[idx] = runWithBuffer(() => fn(subscriber));
            }),
          rendererOptions: {
            persistentOutput: true,
          },
        };
      }),
      { concurrent: true, renderer: spinners ? "default" : "silent" },
    );

    const ctx = await tasks.run();
    const results = await Promise.all(ctx.results);

    for (const { buffer } of results) {
      await pipeline(buffer, output, { end: false });
    }
  });
};
