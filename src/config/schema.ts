import { z } from "zod";

const ImportNameSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "Must be a valid JavaScript identifier");

const ImportExtensionSchema = z
  .string()
  .regex(
    /^(?:|\.[A-Za-z0-9]+)$/,
    "Must be empty or a dot-prefixed extension",
  )
  .default("");

const ImportHookSchema = z
  .object({
    // Import path for the hook, relative to the config
    importPath: z.string().min(1),
    // Name of the exported hook
    importName: ImportNameSchema,
    // Extension to append to the import, if necessary (e.g., '.js' or '.ts')
    importExtension: ImportExtensionSchema,
  })
  .nullish();

const EmbedSchema = z
  .object({
    // Resource paths whose values should be embedded in the generated client
    paths: z.array(z.string()).default([]),
    // Whether to resolve $var: references dynamically at runtime
    resolveVariables: z.boolean().default(true),
  })
  .prefault({});

const ResourceOptionsSchema = z
  .object({
    // Map from resource type to default resource path
    defaults: z.record(z.string(), z.string().nullable()).default({}),
    transformer: ImportHookSchema,
    individualResourceTypeExports: z.boolean().default(false),
    // When true, resource type schemas will use z.looseObject() instead of z.object()
    // to allow passthrough of unknown fields
    looseSchemas: z.boolean().default(false),
    // Embed resource values directly in the generated client
    embed: EmbedSchema,
    // Optional resolver hook consulted before embedded/backend resource fetches
    resolver: ImportHookSchema,
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

const HubOptionsSchema = z
  .object({
    // online: refresh from the public Hub when local/catalog inputs are
    // incomplete; offline: never contact the Hub.
    mode: z.enum(["online", "offline"]).default("online"),
  })
  .prefault({});

const SourceResourceTypesSchema = z
  .object({
    // Optional supplemental catalog of ResourceType-like objects, resolved
    // relative to the config file.
    file: z.string().min(1).optional(),
    hub: HubOptionsSchema,
  })
  .prefault({});

// Optional local-source block. When present (or --from-folder is passed),
// generation reads metadata from a wmill sync tree instead of a live workspace.
const SourceSchema = z
  .object({
    // Path to the wmill sync root, resolved relative to the config file.
    folder: z.string().min(1).optional(),
    // Honor wmill.yaml includes/excludes/skip* (default true).
    respectWmillYaml: z.boolean().default(true),
    // Override the disposable cache directory, resolved relative to the config.
    cacheDir: z.string().min(1).optional(),
    resourceTypes: SourceResourceTypesSchema,
  })
  .optional();

export const ConfigSchema = z
  .object({
    resources: ResourceOptionsSchema,
    scripts: ScriptOptionsSchema,
    flows: FlowOptionsSchema,
    fetchRetry: FetchRetryOptionsSchema,
    source: SourceSchema,
  })
  .prefault({});
