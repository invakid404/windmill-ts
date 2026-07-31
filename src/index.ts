#!/usr/bin/env node

import packageJSON from "../package.json" with { type: "json" };
import { Command } from "commander";
import { setup } from "./windmill/client.js";
import { getActiveWorkspaceName, getWorkspace } from "./windmill/workspace.js";
import { generate } from "./generator/index.js";
import type { GenerationSource } from "./source/types.js";
import { remoteSource } from "./source/remote.js";
import { createLocalSource } from "./source/local/index.js";
import { resolveSourceSelection } from "./source/options.js";
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

    // NOTE: the global fetch retry patch is applied only on the remote path
    //       (see below), so local generation stays free of the monkeypatch.
    if (!config.scripts.enabled) {
      console.warn(chalk.yellow("⚠️ Script generation is disabled in config"));
    }
    if (!config.flows.enabled) {
      console.warn(chalk.yellow("⚠️ Flow generation is disabled in config"));
    }
  });

type GenerateCliOptions = {
  workspace?: string;
  fromFolder?: string;
  resourceTypesFile?: string;
  cacheDir?: string;
  offline?: boolean;
  verbose?: boolean;
};

program
  .command("generate", { isDefault: true })
  .description("Generate client")
  .argument("<output>", "output path; provide - to output to stdout")
  .option(
    "-w, --workspace <name>",
    "target Windmill workspace, defaults to the active Windmill CLI workspace",
  )
  .option(
    "--from-folder <path>",
    "generate from a local wmill-synced folder instead of a live workspace",
  )
  .option(
    "--resource-types-file <path>",
    "optional supplemental resource-type catalog (local mode only)",
  )
  .option(
    "--cache-dir <path>",
    "override the disposable local-source cache directory (local mode only)",
  )
  .option(
    "--offline",
    "forbid the public Hub refresh request (local mode only)",
  )
  .option("-v, --verbose", "emit verbose diagnostics on stderr")
  .action(async (output: string, options: GenerateCliOptions) => {
    const isStdout = output === "-";
    const cwd = process.cwd();
    const config = await getConfig();

    const selection = resolveSourceSelection(
      {
        workspace: options.workspace,
        fromFolder: options.fromFolder,
        resourceTypesFile: options.resourceTypesFile,
        cacheDir: options.cacheDir,
        offline: options.offline,
      },
      config,
      cwd,
    );

    let source: GenerationSource;

    if (selection.mode === "local") {
      // Local mode: no workspace store, no client setup, no global fetch patch.
      source = await createLocalSource({
        folder: selection.folder,
        respectWmillYaml: selection.respectWmillYaml,
        resourceTypesFile: selection.resourceTypesFile,
        cacheDir: selection.cacheDir,
        hubMode: selection.hubMode,
        verbose: options.verbose ?? false,
      });
    } else {
      let workspaceName = selection.workspace;
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
          `Workspace with name "${workspaceName}" not found in Windmill CLI config`,
        );
      }

      // Apply the fetch retry monkeypatch before any windmill-client calls.
      patchFetchWithRetry(config.fetchRetry);
      setup(workspace);
      source = remoteSource;
    }

    const stream = isStdout ? process.stdout : fs.createWriteStream(output);

    await generate(
      stream,
      isStdout ? cwd : path.dirname(path.resolve(cwd, output)),
      {
        spinners: !isStdout,
        source,
      },
    );
  });

program.parse();
