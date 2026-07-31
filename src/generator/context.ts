import { AsyncLocalStorage } from "node:async_hooks";
import { PassThrough, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  GenerationSource,
  ResourceTypes,
  WorkspaceResources,
} from "../source/types.js";
import { getConfig, type Config } from "../config/index.js";

/**
 * Everything the generator tasks share, apart from the output stream they
 * write to.
 */
export type SharedContext = {
  outputDir: string;
  // NOTE: only contains resource types that have at least one resource in the
  //       workspace, as those are the only ones we emit schemas for; anything
  //       else has to fall back to `z.any()` (see `schemaToZod`)
  resourceTypes: ResourceTypes;
  workspaceResources: WorkspaceResources;
  // The data source generation metadata is read from (remote HTTP or a local
  // wmill-synced folder). Injected here so tasks never reach for a global.
  source: GenerationSource;
};

type GenerateContext = SharedContext & {
  write: (content: string) => Promise<void>;
  deferWrite: (content: string) => void;
  config: Config;
};

const generateStore = new AsyncLocalStorage<GenerateContext>();

export const run = async <T,>(
  output: Writable,
  shared: SharedContext,
  cb: () => T,
) => {
  const write = (content: string, stream = output) =>
    new Promise<void>((resolve, reject) =>
      stream.write(content + "\n", (err) => {
        if (err != null) {
          return void reject(err);
        }

        resolve();
      }),
    );

  const end = (stream: Writable) =>
    new Promise<void>((resolve) => stream.end(() => resolve()));

  const deferredWrites: string[] = [];

  // NOTE: if we're running in a nested context, we want to lift deferred
  //       writes to the outermost context so they happen at the very end
  const deferWrite =
    getContext()?.deferWrite ??
    ((content: string) => {
      deferredWrites.push(content);
    });

  const result = await generateStore.run(
    {
      ...shared,
      write,
      deferWrite,
      config: await getConfig(),
    },
    cb,
  );

  // Execute deferred writes
  if (deferredWrites.length > 0) {
    const buffer = new PassThrough();

    // NOTE: in order to avoid the output being dependent on the write order,
    //       deferred writes are sorted before written to the output
    await write(deferredWrites.sort().join("\n"), buffer);
    await end(buffer);

    await pipeline(buffer, output, { end: false });
  }

  await end(output);

  return result;
};

export const getContext = () => generateStore.getStore();
