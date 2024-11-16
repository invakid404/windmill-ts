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

## Generated Client Usage

The generated client provides type-safe functions for running scripts and flows:

```typescript
import {
  runScript,
  runScriptAsync,
  runFlow,
  runFlowAsync,
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
```

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
