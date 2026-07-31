import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import type { MetadataKind } from "./discovery.js";
import { describeParseLocation } from "./parsing.js";

/**
 * The subset of `wmill.yaml` that constrains which recognized metadata files
 * are considered "deployable" and therefore in scope for generation. Unrelated
 * keys (codebases, defaultTs, ...) are ignored. Branch metadata is parsed only
 * to reject branch-specific resource variants (D8), never to select a branch.
 */
export type WmillConfig = {
  includes?: string[];
  excludes?: string[];
  extraIncludes?: string[];
  skipScripts?: boolean;
  skipFlows?: boolean;
  skipResources?: boolean;
  skipResourceTypes?: boolean;
  /** Declared git branch names (keys under `gitBranches`/`git_branches`). */
  gitBranchNames?: string[];
  /** Base resource paths referenced by any `specificItems.resources` list. */
  specificResourcePaths?: string[];
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * Extract declared branch names and every base resource path referenced by a
 * `specificItems.resources` list, from both the current `gitBranches` shape and
 * the legacy `git_branches` alias. We never resolve or select a branch — this
 * only feeds the D8 branch-specific-resource rejection.
 */
const parseBranchInfo = (
  raw: Record<string, unknown>,
): { gitBranchNames: string[]; specificResourcePaths: string[] } => {
  const branchNames = new Set<string>();
  const specificResources = new Set<string>();

  const collectSpecificItems = (specificItems: unknown): void => {
    if (!isRecord(specificItems)) {
      return;
    }
    for (const path of asStringArray(specificItems["resources"]) ?? []) {
      specificResources.add(path);
    }
  };

  for (const key of ["gitBranches", "git_branches"]) {
    const gitBranches = raw[key];
    if (!isRecord(gitBranches)) {
      continue;
    }
    for (const [branchKey, branchValue] of Object.entries(gitBranches)) {
      if (branchKey === "commonSpecificItems") {
        collectSpecificItems(branchValue);
        continue;
      }
      branchNames.add(branchKey);
      if (isRecord(branchValue)) {
        collectSpecificItems(branchValue["specificItems"]);
      }
    }
  }

  return {
    gitBranchNames: [...branchNames],
    specificResourcePaths: [...specificResources],
  };
};

/** Load `wmill.yaml` from the source root, or `null` when absent. */
export const loadWmillConfig = async (
  root: string,
): Promise<WmillConfig | null> => {
  const configPath = join(root, "wmill.yaml");

  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    // Surface the resolved path and error code only — never raw content.
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`Cannot read ${configPath}: ${code}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = (parseYaml(content) ?? {}) as Record<string, unknown>;
  } catch (err) {
    // Value-safe: same policy as B1 — no source snippet is interpolated.
    throw new Error(
      `Failed to parse ${configPath}${describeParseLocation(err)}`,
    );
  }

  const { gitBranchNames, specificResourcePaths } = parseBranchInfo(raw);

  return {
    includes: asStringArray(raw["includes"]),
    excludes: asStringArray(raw["excludes"]),
    extraIncludes: asStringArray(raw["extraIncludes"]),
    skipScripts: asBoolean(raw["skipScripts"]),
    skipFlows: asBoolean(raw["skipFlows"]),
    skipResources: asBoolean(raw["skipResources"]),
    skipResourceTypes: asBoolean(raw["skipResourceTypes"]),
    gitBranchNames,
    specificResourcePaths,
  };
};

export type DiscoveryFilter = {
  isKindSkipped(kind: MetadataKind): boolean;
  isPathIncluded(relPath: string): boolean;
};

/**
 * Build include/exclude and category-skip predicates from `wmill.yaml`, mirroring
 * the wmill CLI's file-oriented matching: a whitelist is active only when
 * `includes` or `excludes` is non-empty, and matching is `includes.some` AND
 * `excludes.every(!)` AND (`extraIncludes` empty OR some match). Resource-type
 * files bypass the path filter at the call site (mirroring the CLI); only
 * `skipResourceTypes` gates them.
 */
export const buildFilter = (config: WmillConfig | null): DiscoveryFilter => {
  const includes = config?.includes ?? [];
  const excludes = config?.excludes ?? [];
  const extraIncludes = config?.extraIncludes ?? [];
  const hasWhitelist = includes.length > 0 || excludes.length > 0;

  const isPathIncluded = (relPath: string): boolean => {
    if (!hasWhitelist) {
      return true;
    }
    const included =
      includes.length === 0 || includes.some((i) => minimatch(relPath, i));
    const notExcluded = excludes.every((e) => !minimatch(relPath, e));
    const extra =
      extraIncludes.length === 0 ||
      extraIncludes.some((i) => minimatch(relPath, i));
    return included && notExcluded && extra;
  };

  const isKindSkipped = (kind: MetadataKind): boolean => {
    switch (kind) {
      case "script":
        return config?.skipScripts ?? false;
      case "flow":
        return config?.skipFlows ?? false;
      case "resource":
        return config?.skipResources ?? false;
      case "resourceType":
        return config?.skipResourceTypes ?? false;
    }
  };

  return { isPathIncluded, isKindSkipped };
};
