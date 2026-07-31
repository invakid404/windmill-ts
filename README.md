# windmill-ts

A TypeScript code generator for creating type-safe clients for
[Windmill](https://www.windmill.dev/).

https://github.com/user-attachments/assets/b6bc15a0-3e17-4d93-8b7f-cf10505e14c9

Under the hood, it uses the official
[windmill-client](http://npm.im/windmill-client) library to interact with
Windmill, and exposes a similar interface.

The output is a single file that could be used from Windmill itself (by creating
a script from the output and importing it from other TypeScript files), and from
your own codebase (by setting up `windmill-client` in it).

## Features

- Generates fully typed TypeScript client code for your Windmill workspace
- Type-safe access to scripts, flows and resources
- Automatic schema generation from Windmill's JSON schemas
- Integration with the Windmill CLI configuration

## Requirements

- **Remote mode (default):** a configured Windmill CLI environment.
- **Local mode (`--from-folder`):** only a
  [`wmill sync`](https://www.windmill.dev/docs/advanced/cli/sync)-produced folder
  on disk. No configured Windmill CLI workspace is required; generation reads
  metadata from the folder and, when needed, fetches public resource-type schemas
  from the Windmill Hub (see [Generating from a local folder](#generating-from-a-local-folder)).

Refer to the
[Windmill docs](https://www.windmill.dev/docs/advanced/cli/installation) for
instructions on how to set up the Windmill CLI.

## Installation

```bash
npm install windmill-ts
```

## Usage

The simplest way to use windmill-ts is to run it with no arguments, which will
use your active Windmill CLI workspace:

```bash
npx windmill-ts ./generated-client.ts
```

You can also specify a specific workspace:

```bash
npx windmill-ts -w my-workspace ./generated-client.ts
```

To output to stdout instead of a file, use `-` as the output path:

```bash
npx windmill-ts -
```

## Generating from a local folder

Instead of a live workspace, windmill-ts can generate from a local folder
produced by [`wmill sync`](https://www.windmill.dev/docs/advanced/cli/sync).
Point it at the sync root with `--from-folder`:

```bash
npx windmill-ts --from-folder ./windmill ./generated-client.ts
```

The generator and the emitted client are identical to remote mode; only the
_source of the generation metadata_ changes. Local mode does not read your
Windmill CLI workspace store, does not call the private API, and does not apply
the global fetch-retry patch.

### Local mode options

| Flag | Description |
| --- | --- |
| `--from-folder <path>` | Generate from a local wmill-synced folder. Conflicts with `--workspace`. |
| `--resource-types-file <path>` | Optional supplemental resource-type catalog (local mode only). |
| `--cache-dir <path>` | Override the disposable Hub cache directory (local mode only). |
| `--offline` | Forbid the public Hub refresh request (local mode only). |
| `--verbose` | Emit extra diagnostics (cache directory, omitted Hub types) on stderr. |

CLI paths are resolved relative to the current working directory; configured
paths (see the `source` block below) are resolved relative to the config file.

### Supported on-disk formats

Discovery recognizes the metadata `wmill sync` writes, in both its default YAML
form and its `--json` form:

- Scripts: `*.script.yaml` / `*.script.json`
- Flows: `<path>.flow/flow.yaml`, `<path>__flow/flow.yaml`, and flat `<path>.flow.json`
- Resources: `*.resource.yaml` / `*.resource.json`
- Resource types: root-level `*.resource-type.yaml` / `*.resource-type.json`

Only script/flow input schemas and resource `path`/`resource_type`/`value` are
consumed; companion source, locks, apps, variables, schedules, and triggers are
ignored. Two files that resolve to the same logical path (for example a YAML and
a JSON of the same script) are a hard error naming both files.

By default the relevant parts of `wmill.yaml` (`includes`, `excludes`,
`extraIncludes`, and `skipScripts`/`skipFlows`/`skipResources`/`skipResourceTypes`)
constrain discovery to what the folder would deploy. Set
`source.respectWmillYaml: false` to crawl the literal disk contents instead.

### Resource-type schemas and the Windmill Hub

A normal sync tree usually contains your workspace's _custom_ resource-type
definitions, but not the server/Hub-provided ones. When a resource uses a type
that your local `*.resource-type.yaml` files (and an optional committed catalog)
do not define, windmill-ts completes the missing schemas from the public Windmill
Hub:

```http
GET https://hub.windmill.dev/resource_types/list
Accept: application/json
```

This request is unauthenticated and sends no workspace token, email, UID,
resource path, or type name — it fetches the whole public catalog and windmill-ts
selects only the types it needs. Each record's `schema` arrives as a
JSON-encoded string, which windmill-ts parses; records with a missing/invalid
schema are skipped. Precedence is **local `*.resource-type.*` > catalog > Hub**.
If a _used_ type still has no valid schema after all sources, generation fails
(it never falls back to a permissive `z.any()`).

The endpoint is unversioned and carries no formal API/rate contract, so
windmill-ts makes at most one full-list request per Hub-dependent run, validates
every response, and honors `Retry-After`.

**Refresh, cache, and offline behavior:**

- On every online run that needs Hub data, windmill-ts refreshes the full list
  and content-hashes it. If the normalized content changed, it reports the old→new
  hash and atomically replaces the cache; an identical hash leaves the cache
  untouched.
- The cache is a **disposable** performance/outage cache, not a reproducibility
  lock. It is stored in the nearest writable
  `node_modules/.cache/windmill-ts/resource-types-v1.json` (searching from your
  project up to the containing Git/workspace root), falling back to a
  project-keyed OS cache and then a temp directory. It is normally gitignored via
  `node_modules`; **do not commit it.** Override the location with `--cache-dir`
  or `source.cacheDir`. Use `--verbose` to see which directory was chosen.
- If an online refresh fails but a valid cache already completes every used type,
  windmill-ts continues with a prominent stderr warning that includes the cache's
  capture time and hash. If the cache is missing or incomplete, it fails.
- `--offline` (or `source.resourceTypes.hub.mode: offline`) never contacts the
  Hub; it uses only local definitions, the catalog, and any existing cache, and
  fails if those are incomplete.

**Reproducible CI:** because Hub state is unversioned and the cache is
ephemeral, teams that need identical commit-to-output behavior should commit a
complete `source.resourceTypes.file` catalog (ideally exported from the exact
origin server they target) and run with `--offline`. A complete local/catalog set
makes no Hub request at all. Committing or redistributing Hub-derived schema data
is your responsibility to review against applicable Windmill terms.

### Generation-time vs. runtime networking

"Local" describes only how generation metadata is obtained. The generated client
still calls Windmill at runtime for `runScript`/`runFlow`/`getResource` unless a
resource is embedded or a resolver is supplied. Local generation itself is
network-free when local + committed-catalog inputs are complete or `--offline`
is set; otherwise its only network access is the single public Hub request above.

## Configuration

windmill-ts can be configured using a YAML configuration file. The configuration
file can be named either `windmill-ts.yaml` or `windmill-ts.yml` and should be
placed in your project root directory.

The configuration file supports the following options:

```yaml
# Resource configuration
resources:
  # Map of resource type to default resource path
  # By default, if there is only one resource of a given type,
  # it will be set as the default implicitly.
  # You can override this behavior by:
  # 1. Setting a specific resource path as the default
  # 2. Setting null to disable the implicit default behavior
  defaults:
    # Override the default for "postgresql" resources to always use this path
    postgresql: "f/prod/postgresql"
    # Disable implicit default for "s3" resources even if there's only one
    s3: null
    # Set a specific default for "mysql" resources
    mysql: "f/dev/mysql"

  # Optional transformer configuration for customizing resource handling
  transformer:
    # Import path for the transformer, relative to the config
    importPath: "./transformer"
    # Name of the exported transformer
    importName: "ResourceTransformer"
    # Optional extension to append to the import (e.g., ".ts" or ".js")
    importExtension: ".js"

  # Optional resolver hook consulted before the generated client falls back to
  # embedded resource values or wmill.getResource(path).
  resolver:
    # Import path for the resolver, relative to the config
    importPath: "./resource-resolver"
    # Name of the exported resolver function
    importName: "resolveResource"
    # Optional extension to append to the import (e.g., ".ts" or ".js")
    importExtension: ".js"

# Script generation configuration
scripts:
  # Whether to generate script-related code (default: true)
  enabled: true
  # Allow extra arguments by generating z.looseObject-based schemas (default: false)
  looseArgs: false

# Flow generation configuration
flows:
  # Whether to generate flow-related code (default: true)
  enabled: true
  # Allow extra arguments by generating z.looseObject-based schemas (default: false)
  looseArgs: false

  # Embed raw resource values directly in the generated client
  # (also available under `resources.embed`).
  # WARNING: embedded values are serialized verbatim into the generated
  #          TypeScript. If a resource value contains a literal secret, that
  #          secret ends up in the generated source and any artifacts built from
  #          it. Prefer `$var:` references (resolved at runtime) for secrets and
  #          review/secure the generated output.

# Local-source configuration (used with --from-folder, or on its own to select
# local mode when no --workspace/--from-folder is passed). All paths are resolved
# relative to this config file.
source:
  # Path to the wmill sync root.
  folder: ./windmill
  # Honor wmill.yaml includes/excludes/skip* (default: true).
  respectWmillYaml: true
  # Optional override for the disposable Hub cache directory. Default is the
  # auto-resolved node_modules/.cache/windmill-ts, then a project-keyed OS
  # cache/temp fallback.
  cacheDir: ./custom-cache
  resourceTypes:
    # Optional committed catalog of resource-type definitions (JSON or YAML,
    # an array of { name, schema, description?, format_extension? }). Overrides
    # Hub data; local *.resource-type.* files override this. Use it for private
    # or pinned schemas and for reproducible offline CI.
    file: ./windmill-resource-types.json
    hub:
      # online: refresh from the public Hub when local/catalog inputs are
      # incomplete. offline: never contact the Hub.
      mode: online
```

The configuration file is optional. If not provided, windmill-ts will use
default values. For resources, this means that when there is exactly one
resource of a given type, it will be set as the default implicitly. You can
override this behavior in the configuration file by either specifying a
different default path or setting it to `null` to disable the implicit default
behavior.

## Generated Client Usage

The generated client provides type-safe functions for running scripts and flows,
and getting resources:

```typescript
import {
  runScript,
  runScriptAsync,
  runFlow,
  runFlowAsync,
  getResource,
} from "./generated-client";

// Run a script synchronously
const result = await runScript("my/script/path", {
  // TypeScript will enforce the correct argument types here
  arg1: "value",
  arg2: 42,
});

// Run a script asynchronously
const jobId = await runScriptAsync("my/script/path", {
  arg1: "value",
  arg2: 42,
});

// Run a flow
const flowResult = await runFlow("my/flow/path", {
  input1: "value",
  input2: true,
});

// Get a resource with type validation
const resource = await getResource("my/resource/path");
// TypeScript will infer the correct type based on the resource type
```

### Resource Resolver Hook

Generated clients export a `ResourceResolver` hook API. A resolver can return a
resource value before the normal generated behavior runs. Returning `undefined`
continues to the default behavior: embedded value first when configured, then
`wmill.getResource(path)`. Returned values still go through normal validation
and resource transformers unless the caller uses `skipValidation` or
`skipTransformer`.

Configured resolvers are imported from `resources.resolver`:

```typescript
import type { ResourceResolver } from "./generated-client";

export const resolveResource: ResourceResolver = ({ path }) => {
  if (path === "f/app/redis" && !process.env["WM_JOB_ID"]) {
    return {
      value: {
        host: process.env["REDIS_HOST"],
        port: Number(process.env["REDIS_PORT"] ?? 6379),
      },
    };
  }

  return undefined;
};
```

Configured resolver modules are imported by the generated client in every
environment that imports the client, so their top-level imports and side effects
run everywhere. Keep top-level imports safe for all target runtimes; if a
resolver needs a module that is only available in one environment, load it with a
dynamic `import()` inside that branch. Use `import type` for generated-client
types to avoid a value-import cycle back into the generated client.

You can also register or replace a resolver at runtime:

```typescript
import { resolvedResource, setResourceResolver } from "./generated-client";

setResourceResolver(({ path }) => {
  if (path === "f/app/redis") {
    return resolvedResource({ host: "localhost", port: 6379 });
  }

  return undefined;
});
```

The resolver context includes:

- `path` and `resourceType`
- `options`, the `getResource` options for the current call
- `hasEmbeddedResource`
- `resolveEmbedded()`, `fetchResource()`, and `resolveDefault()` helpers

## How It Works

The generator:

1. Selects a source provider — a live Windmill workspace (remote mode) or a
   local wmill-synced folder (`--from-folder`; see
   [Generating from a local folder](#generating-from-a-local-folder))
2. Obtains all available scripts, flows and resource types from that source,
   fetching over HTTP in remote mode or reading metadata from disk (plus the
   public Hub for missing resource-type schemas) in local mode
3. Generates Zod schemas for validating inputs
4. Creates type-safe wrapper functions for running scripts and flows
5. Handles resource type references and validations

The generated client and the codegen pipeline are identical in both modes; only
the source of the generation metadata differs.

## License

This project is licensed under the Unlicense - see the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
