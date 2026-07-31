import type { ResourceTypes, SourceResourceType } from "../types.js";

export type HubMode = "online" | "offline";

/**
 * Everything the resource-type composition needs. In Step B only `localDefs` is
 * consumed; the catalog/Hub/cache fields are wired through by `createLocalSource`
 * and honored by the full composition added in Step C.
 */
export type ComposeResourceTypesParams = {
  localDefs: Map<string, SourceResourceType>;
  /** Distinct resource-type names actually used by non-excluded resources. */
  usedNames: Set<string>;
  /** Absolute path to an optional supplemental catalog file, or null. */
  resourceTypesFile: string | null;
  /** Absolute cache-dir override, or null to auto-resolve. */
  cacheDir: string | null;
  hubMode: HubMode;
  verbose: boolean;
  /** Real source root, for diagnostics/project-key derivation. */
  root: string;
  /** Injectable fetch for tests; undefined uses the default implementation. */
  fetchImpl?: typeof fetch;
};

/**
 * Compose the resource-type map from local definitions plus (Step C) an optional
 * committed catalog and the public Hub. Precedence is local > catalog > Hub.
 *
 * NOTE: Step B implements only the local-definition layer. The catalog, Hub
 *       fetch/cache, and used-type completeness enforcement are added in Step C
 *       without changing this signature.
 */
export const composeResourceTypes = async (
  params: ComposeResourceTypesParams,
): Promise<ResourceTypes> => {
  return new Map(params.localDefs);
};
