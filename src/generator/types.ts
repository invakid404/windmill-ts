import type { Walker } from "json-schema-walker";

export type JSONSchema = Parameters<
  InstanceType<typeof Walker>["loadSchema"]
>[0];
