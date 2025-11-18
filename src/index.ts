#!/usr/bin/env node

import packageJSON from "../package.json" with { type: "json" };
import { Command } from "commander";
import { setup } from "./windmill/client.js";
import { getActiveWorkspaceName, getWorkspace } from "./windmill/workspace.js";
import { generate } from "./generator/index.js";
import * as fs from "node:fs";
import chalk from "chalk";
import { getConfig } from "./config/index.js";
import * as path from "node:path";
import { patchFetchWithRetry } from "./utils/fetchRetry.js";

const program = new Command();

program
  .name("windmill-ts")
  .description("Type-safe Windmill client for TypeScript")
  .version(packageJSON.version)
  .hook("preAction", async () => {
    const config = await getConfig();

    // Apply fetch retry monkeypatch early, before any windmill-client calls
    patchFetchWithRetry(config.fetchRetry);

    if (!config.scripts.enabled) {
      console.warn(chalk.yellow("⚠️ Script generation is disabled in config"));
    }
    if (!config.flows.enabled) {
      console.warn(chalk.yellow("⚠️ Flow generation is disabled in config"));
    }
  });

program
  .command("generate", { isDefault: true })
  .description("Generate client")
  .argument("<output>", "output path; provide - to output to stdout")
  .option(
    "-w, --workspace <name>",
    "target Windmill workspace, defaults to the active Windmill CLI workspace",
  )
  .action(async (output: string, options: { workspace?: string }) => {
    const isStdout = output === "-";

    let workspaceName = options.workspace;
    if (!workspaceName) {
      workspaceName = await getActiveWorkspaceName();

      if (!isStdout) {
        console.error(
          chalk.yellow(
            `⚠️ Workspace name not provided, defaulting to "${workspaceName}"`,
          ),
        );
      }
    }

    const workspace = await getWorkspace(workspaceName);
    if (workspace == null) {
      throw new Error(
        `Workspace with name ${workspace} not found in Windmill CLI config`,
      );
    }

    setup(workspace);

    const stream = isStdout ? process.stdout : fs.createWriteStream(output);
    const cwd = process.cwd();

    await generate(
      stream,
      isStdout ? cwd : path.dirname(path.resolve(cwd, output)),
      {
        spinners: !isStdout,
      },
    );
  });

program.parse();
