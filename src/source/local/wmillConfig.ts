import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";
import type { MetadataKind } from "./discovery.js";

/**
 * The subset of `wmill.yaml` that constrains which recognized metadata files
 * are considered "deployable" and therefore in scope for generation. Unrelated
 * keys (codebases, defaultTs, gitBranches, ...) are ignored.
 */
export type WmillConfig = {
  includes?: string[];
  excludes?: string[];
  extraIncludes?: string[];
  skipScripts?: boolean;
  skipFlows?: boolean;
  skipResources?: boolean;
  skipResourceTypes?: boolean;
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : undefined;

const asBoolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

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
    throw err;
  }

  const raw = (parseYaml(content) ?? {}) as Record<string, unknown>;

  return {
    includes: asStringArray(raw["includes"]),
    excludes: asStringArray(raw["excludes"]),
    extraIncludes: asStringArray(raw["extraIncludes"]),
    skipScripts: asBoolean(raw["skipScripts"]),
    skipFlows: asBoolean(raw["skipFlows"]),
    skipResources: asBoolean(raw["skipResources"]),
    skipResourceTypes: asBoolean(raw["skipResourceTypes"]),
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
