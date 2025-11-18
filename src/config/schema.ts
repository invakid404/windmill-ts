import { z } from "zod";

const TransformerSchema = z
  .object({
    // Import path for the transformer, relative to the config
    importPath: z.string(),
    // Name of the exported transformer
    importName: z.string(),
    // Extension to append to the import, if necessary (e.g., '.js' or '.ts')
    importExtension: z.string().default(""),
  })
  .nullish();

const ResourceOptionsSchema = z
  .object({
    // Map from resource type to default resource path
    defaults: z.record(z.string(), z.string().nullable()).default({}),
    transformer: TransformerSchema,
    individualResourceTypeExports: z.boolean().default(false),
  })
  .prefault({});

const ScriptOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    looseArgs: z.boolean().default(false),
  })
  .prefault({});

const FlowOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    looseArgs: z.boolean().default(false),
  })
  .prefault({});

const FetchRetryOptionsSchema = z
  .object({
    enabled: z.boolean().default(true),
    retries: z.number().int().min(0).default(3),
    minTimeout: z.number().int().min(0).default(1000),
    maxTimeout: z.number().int().min(0).default(10000),
    factor: z.number().min(1).default(2),
  })
  .prefault({});

export const ConfigSchema = z
  .object({
    resources: ResourceOptionsSchema,
    scripts: ScriptOptionsSchema,
    flows: FlowOptionsSchema,
    fetchRetry: FetchRetryOptionsSchema,
  })
  .prefault({});
