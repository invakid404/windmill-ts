import { AsyncLocalStorage } from "node:async_hooks";
import { Writable } from "node:stream";

type GenerateContext = {
  write: (content: string) => Promise<void>;
};

const generateStore = new AsyncLocalStorage<GenerateContext>();

export const run = <T,>(output: Writable, cb: () => T) => {
  const write = (content: string) =>
    new Promise<void>((resolve, reject) =>
      output.write(content + "\n", (err) => {
        if (err != null) {
          return void reject(err);
        }

        resolve();
      }),
    );

  return generateStore.run({ write }, cb);
};

export const getContext = () => generateStore.getStore();
