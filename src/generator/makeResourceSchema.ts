import type { JSONSchema } from "./types.js";

export const makeResourceSchema = (paths: string[]) => {
  const refs = paths.map((path) => `$res:${path}`);

  return {
    type: "string",
    enum: refs,
    ...(refs.length === 1 && { default: refs[0] }),
  } satisfies JSONSchema;
};
