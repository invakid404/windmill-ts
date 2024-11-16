import dedent from "dedent";
import { getContext } from "./context.js";

const preamble = dedent`
  import { z } from 'zod';
  import * as wmill from 'windmill-client';

  const lazyObject = <T,>(fn: () => T) => {
    let instance: T | null = null;
    return new Proxy({}, {
      get(_target, prop) {
        if (instance == null) {
          instance = fn();
        }

        return instance[prop];
      }
    }) as T;
  }
`;

export const writePreamble = () => {
  const { write } = getContext()!;

  write(preamble);
};
