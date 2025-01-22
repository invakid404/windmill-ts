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
  results: Array<Awaited<ReturnType<typeof runWithBuffer>>>;
};

export const generate = async (output: Writable, options?: GenerateOptions) => {
  const { spinners = false } = options ?? {};

  const allResourceTypes = await listResourceTypes();

  return run(output, allResourceTypes, async () => {
    await writePreamble();

    const tasks = new Listr<ListrContext>(
      Object.entries(subtasks).map(([name, fn], idx) => {
        return {
          title: name,
          task: (ctx) =>
            new Observable((subscriber) => {
              runWithBuffer(() => fn(subscriber)).then((result) => {
                ctx.results ??= [];
                ctx.results[idx] = result;
              });
            }),
          rendererOptions: {
            persistentOutput: true,
          },
        };
      }),
      { concurrent: true },
    );

    const { results } = await tasks.run();

    for (const { buffer } of results) {
      await pipeline(buffer, output, { end: false });
    }
  });
};
