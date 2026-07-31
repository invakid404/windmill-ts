import { dirname, resolve } from "node:path";
import type { Config } from "../config/index.js";
import type { HubMode } from "./local/resourceTypes.js";

export type CliSourceOptions = {
  workspace?: string;
  fromFolder?: string;
  resourceTypesFile?: string;
  cacheDir?: string;
  offline?: boolean;
};

export type SourceSelection =
  | { mode: "remote"; workspace?: string }
  | {
      mode: "local";
      folder: string;
      respectWmillYaml: boolean;
      resourceTypesFile: string | null;
      cacheDir: string | null;
      hubMode: HubMode;
    };

/**
 * Resolve the generation mode and all source paths from CLI flags and config,
 * as a pure function so precedence is testable without Commander. CLI paths are
 * resolved against the invocation cwd; configured paths against the config
 * file's directory (matching resource hook imports).
 *
 * Mode precedence:
 *   1. `--from-folder` + `--workspace` → usage error.
 *   2. explicit `--from-folder`      → local (overrides source.folder).
 *   3. explicit `--workspace`        → remote (overrides source.folder).
 *   4. no selector + source.folder   → local.
 *   5. otherwise                     → remote (active workspace).
 */
export const resolveSourceSelection = (
  cli: CliSourceOptions,
  config: Config,
  cwd: string,
): SourceSelection => {
  const configDir = config.configPath ? dirname(config.configPath) : cwd;
  const source = config.source;

  if (cli.fromFolder != null && cli.workspace != null) {
    throw new Error(
      "Options --from-folder and --workspace cannot be used together",
    );
  }

  let folderRaw: string | undefined;
  let folderBase = cwd;
  let mode: "local" | "remote";

  if (cli.fromFolder != null) {
    mode = "local";
    folderRaw = cli.fromFolder;
    folderBase = cwd;
  } else if (cli.workspace != null) {
    mode = "remote";
  } else if (source?.folder != null) {
    mode = "local";
    folderRaw = source.folder;
    folderBase = configDir;
  } else {
    mode = "remote";
  }

  if (mode === "remote") {
    if (cli.resourceTypesFile != null) {
      throw new Error("--resource-types-file is only valid in local mode");
    }
    if (cli.cacheDir != null) {
      throw new Error("--cache-dir is only valid in local mode");
    }
    if (cli.offline) {
      throw new Error("--offline is only valid in local mode");
    }
    return { mode: "remote", workspace: cli.workspace };
  }

  const folder = resolve(folderBase, folderRaw!);
  const respectWmillYaml = source?.respectWmillYaml ?? true;

  let resourceTypesFile: string | null = null;
  if (cli.resourceTypesFile != null) {
    resourceTypesFile = resolve(cwd, cli.resourceTypesFile);
  } else if (source?.resourceTypes?.file != null) {
    resourceTypesFile = resolve(configDir, source.resourceTypes.file);
  }

  let cacheDir: string | null = null;
  if (cli.cacheDir != null) {
    cacheDir = resolve(cwd, cli.cacheDir);
  } else if (source?.cacheDir != null) {
    cacheDir = resolve(configDir, source.cacheDir);
  }

  const hubMode: HubMode = cli.offline
    ? "offline"
    : (source?.resourceTypes?.hub?.mode ?? "online");

  return {
    mode: "local",
    folder,
    respectWmillYaml,
    resourceTypesFile,
    cacheDir,
    hubMode,
  };
};
