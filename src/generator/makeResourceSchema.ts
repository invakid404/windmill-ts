import type { JSONSchema } from "./types.js";

export const makeResourceSchema = (resourceType: string, paths: string[]) =>
  ({
    type: "string",
    enum: paths.map((path) => `$res:${path}`),
  }) satisfies JSONSchema;
