import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";
import { ResourceTypes } from "../windmill/resourceTypes.js";
import { InMemoryDuplex } from "../utils/inMemoryDuplex.js";

type GenerateContext = {
  write: (content: string) => Promise<void>;
  deferWrite: (content: string) => void;
  allResourceTypes: ResourceTypes;
};

const generateStore = new AsyncLocalStorage<GenerateContext>();

export const run = async <T,>(
  output: Writable,
  allResourceTypes: ResourceTypes,
  cb: () => T,
) => {
  const write = (content: string) =>
    new Promise<void>((resolve, reject) =>
      output.write(content + "\n", (err) => {
        if (err != null) {
          return void reject(err);
        }

        resolve();
      }),
    );

  const deferredWrites: string[] = [];

  // NOTE: if we're running in a nested context, we want to lift deferred
  //       writes to the outermost context so they happen at the very end
  const deferWrite =
    getContext()?.deferWrite ??
    ((content: string) => {
      deferredWrites.push(content);
    });

  const result = await generateStore.run(
    { write, deferWrite, allResourceTypes },
    cb,
  );

  // Execute deferred writes
  if (deferredWrites.length > 0) {
    const buffer = new InMemoryDuplex();

    // NOTE: in order to avoid the output being dependent on the write order,
    //       deferred writes are sorted before written to the output
    buffer.write(deferredWrites.sort().join("\n"));
    buffer.pipe(output);
  }

  return result;
};

export const getContext = () => generateStore.getStore();
