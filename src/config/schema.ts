import { z } from "zod";

const ResourceOptionsSchema = z
  .object({
    // Map from resource type to default resource path
    defaults: z.record(z.string(), z.string().nullable()).default({}),
  })
  .default({});

const ScriptOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

const FlowOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .default({});

export const ConfigSchema = z
  .object({
    resources: ResourceOptionsSchema,
    scripts: ScriptOptionsSchema,
    flows: FlowOptionsSchema,
  })
  .default({});

export type Config = z.infer<typeof ConfigSchema>;
