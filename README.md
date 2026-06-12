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

- A configured Windmill CLI environment

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

Configured resolvers are runtime imports used by the generated client in every
runtime that imports it. Avoid value-import cycles back to the generated client;
use `import type` for generated-client types, and keep top-level app-only side
effects out of configured resolver modules.

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

1. Connects to your configured Windmill workspace
2. Fetches all available scripts, flows and resource types
3. Generates Zod schemas for validating inputs
4. Creates type-safe wrapper functions for running scripts and flows
5. Handles resource type references and validations

## License

This project is licensed under the Unlicense - see the LICENSE file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
