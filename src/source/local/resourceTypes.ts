import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import chalk from "chalk";
import type { JSONSchema } from "../../generator/types.js";
import type { ResourceTypes, SourceResourceType } from "../types.js";
import { compareStrings } from "../resources.js";
import { describeParseLocation } from "./parsing.js";
import {
  defaultCacheDirDeps,
  resolveCacheDir,
} from "./cacheDir.js";
import {
  fetchHubResourceTypes,
  HUB_ENDPOINT,
  type HubResourceType,
} from "./hub.js";
import {
  readCache,
  writeCacheIfChanged,
  type CacheReadResult,
} from "./resourceTypeCache.js";

export type HubMode = "online" | "offline";

/**
 * Everything the resource-type composition needs. Catalog/Hub/cache fields are
 * wired through by `createLocalSource`; local `*.resource-type.{yaml,json}`
 * definitions always take final precedence.
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

const CatalogRecordSchema = z.object({
  name: z.string().min(1),
  schema: z.unknown().optional(),
  description: z.unknown().optional(),
  format_extension: z.union([z.string(), z.null()]).optional(),
});
const CatalogSchema = z.array(CatalogRecordSchema);

const shortHash = (hash: string): string => hash.slice(0, 8);

const logDiagnostic = (message: string): void => {
  console.error(message);
};

/** A value-safe description of why an offline cache could not be used. */
const describeCacheState = (
  cacheState: CacheReadResult,
  dir: string | null,
): string => {
  const location = dir ?? "(no writable cache location)";
  if (cacheState.status === "invalid") {
    return `cache at ${location} is invalid: ${cacheState.reason}`;
  }
  return `no cache present at ${location}`;
};

/** Load the optional supplemental catalog file (JSON or YAML). */
const loadCatalog = async (
  file: string,
): Promise<Map<string, SourceResourceType>> => {
  let content: string;
  try {
    content = await readFile(file, "utf-8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read resource-types catalog ${file}: ${reason}`);
  }

  const ext = extname(file).toLowerCase();
  let raw: unknown;
  try {
    raw = ext === ".yaml" || ext === ".yml" ? parseYaml(content) : JSON.parse(content);
  } catch (err) {
    // Never interpolate the raw parser message: a YAML/JSON catalog can embed
    // secret-bearing schemas, so surface only a content-free location.
    throw new Error(
      `Failed to parse resource-types catalog ${file}${describeParseLocation(err)}`,
    );
  }

  const parsed = CatalogSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue?.path?.length ? issue.path.join(".") : "(root)";
    throw new Error(
      `Invalid resource-types catalog ${file} at ${at}: ${issue?.message ?? "expected an array of resource types"}`,
    );
  }

  const map = new Map<string, SourceResourceType>();
  for (const record of parsed.data) {
    if (map.has(record.name)) {
      throw new Error(
        `Resource-types catalog ${file} contains duplicate name ${JSON.stringify(record.name)}`,
      );
    }
    // Every explicit catalog record must carry an object-valued schema (parity
    // with local `*.resource-type.*` definitions); a partial overlay is not a
    // supported v1 merge semantic.
    if (record.schema == null) {
      throw new Error(
        `Missing schema for ${JSON.stringify(record.name)} in resource-types catalog ${file}: a resource type must define an object schema`,
      );
    }
    if (typeof record.schema !== "object" || Array.isArray(record.schema)) {
      throw new Error(
        `Invalid schema for ${JSON.stringify(record.name)} in resource-types catalog ${file}: expected a JSON Schema object`,
      );
    }
    map.set(record.name, {
      name: record.name,
      schema: record.schema as JSONSchema,
      description:
        typeof record.description === "string" ? record.description : undefined,
      format_extension: record.format_extension ?? null,
    });
  }
  return map;
};

const hubToResourceType = (record: HubResourceType): SourceResourceType => ({
  name: record.name,
  schema: record.schema,
  description: record.description ?? undefined,
  format_extension: null,
});

const isResolved = (def: SourceResourceType | undefined): boolean =>
  def != null &&
  def.schema != null &&
  typeof def.schema === "object" &&
  !Array.isArray(def.schema);

/** Merge layers so that later layers override earlier ones. */
const mergeLayers = (
  ...layers: Map<string, SourceResourceType>[]
): Map<string, SourceResourceType> => {
  const merged = new Map<string, SourceResourceType>();
  for (const layer of layers) {
    for (const [name, def] of layer) {
      merged.set(name, def);
    }
  }
  return merged;
};

/**
 * Normalize the composed map to ascending name order so `listResourceTypes()`
 * satisfies the D9 sorted-provider contract regardless of catalog/local/Hub
 * insertion order.
 */
const sortByName = (
  map: Map<string, SourceResourceType>,
): ResourceTypes =>
  new Map([...map.entries()].sort(([a], [b]) => compareStrings(a, b)));

const computeMissing = (
  usedNames: Set<string>,
  merged: Map<string, SourceResourceType>,
): string[] =>
  [...usedNames].filter((name) => !isResolved(merged.get(name))).sort(compareStrings);

const selectFromCache = (
  cacheState: CacheReadResult,
  names: Iterable<string>,
): Map<string, SourceResourceType> => {
  const layer = new Map<string, SourceResourceType>();
  if (cacheState.status !== "ok") {
    return layer;
  }
  const byName = new Map(
    cacheState.cache.resourceTypes.map((record) => [record.name, record] as const),
  );
  for (const name of names) {
    const record = byName.get(name);
    if (record) {
      layer.set(name, hubToResourceType(record));
    }
  }
  return layer;
};

/**
 * Compose the resource-type map from local definitions, an optional committed
 * catalog, and the public Hub (fresh or cached), enforcing that every used type
 * resolves to a valid schema. Precedence is local > catalog > Hub. The Hub is
 * consulted only when local+catalog leave used types unresolved.
 */
export const composeResourceTypes = async (
  params: ComposeResourceTypesParams,
): Promise<ResourceTypes> => {
  const {
    localDefs,
    usedNames,
    resourceTypesFile,
    cacheDir,
    hubMode,
    verbose,
    fetchImpl,
  } = params;

  const catalog = resourceTypesFile
    ? await loadCatalog(resourceTypesFile)
    : new Map<string, SourceResourceType>();

  const localAndCatalog = mergeLayers(catalog, localDefs);
  const missing = computeMissing(usedNames, localAndCatalog);

  // Complete without the Hub — no cache dependence and no network at all.
  if (missing.length === 0) {
    return sortByName(localAndCatalog);
  }

  const resolution = resolveCacheDir(
    { override: cacheDir },
    defaultCacheDirDeps(),
  );
  if (verbose) {
    logDiagnostic(
      chalk.dim(
        `windmill-ts: cache directory ${resolution.dir ?? "(none)"} [${resolution.kind}]`,
      ),
    );
  }
  const cacheState: CacheReadResult = resolution.dir
    ? await readCache(resolution.dir)
    : { status: "missing" };

  const failIncomplete = (
    stillMissing: string[],
    detail: string,
  ): never => {
    throw new Error(
      `Unresolved resource types used by local resources: ${stillMissing.join(", ")}. ${detail}`,
    );
  };

  if (hubMode === "offline") {
    const hubLayer = selectFromCache(cacheState, missing);
    const merged = mergeLayers(hubLayer, catalog, localDefs);
    const stillMissing = computeMissing(usedNames, merged);
    if (stillMissing.length > 0) {
      failIncomplete(
        stillMissing,
        cacheState.status === "ok"
          ? `Offline mode: cached Hub catalog (${shortHash(cacheState.hash)}, captured ${cacheState.cache.capturedAt}) does not define them. Provide them via a committed source.resourceTypes.file catalog.`
          : `Offline mode: no usable Hub cache available (${describeCacheState(cacheState, resolution.dir)}). Provide them via a committed source.resourceTypes.file catalog or run online once.`,
      );
    }
    return sortByName(merged);
  }

  // Online mode: attempt one full-list refresh.
  let fetched;
  try {
    fetched = await fetchHubResourceTypes({ fetchImpl });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const hubLayer = selectFromCache(cacheState, missing);
    const merged = mergeLayers(hubLayer, catalog, localDefs);
    const stillMissing = computeMissing(usedNames, merged);
    if (stillMissing.length === 0 && cacheState.status === "ok") {
      logDiagnostic(
        chalk.yellow(
          `⚠️ Hub refresh failed (${reason}); using cached catalog from ${cacheState.cache.capturedAt} (${shortHash(cacheState.hash)}) at ${HUB_ENDPOINT}`,
        ),
      );
      return merged;
    }
    return failIncomplete(
      stillMissing,
      `Hub refresh failed (${reason}) and the cache cannot complete them.`,
    );
  }

  if (verbose && fetched.omitted.length > 0) {
    logDiagnostic(
      chalk.dim(
        `windmill-ts: Hub omitted ${fetched.omitted.length} resource type(s) with invalid schemas: ${fetched.omitted.join(", ")}`,
      ),
    );
  }

  if (resolution.dir) {
    try {
      const capturedAt = new Date().toISOString();
      const writeResult = await writeCacheIfChanged(
        resolution.dir,
        fetched.types,
        capturedAt,
        // The shared temp fallback root must be created private (0700).
        resolution.kind === "temp" ? 0o700 : undefined,
      );
      if (writeResult.written) {
        if (writeResult.previousHash != null) {
          logDiagnostic(
            chalk.yellow(
              `windmill-ts: Hub catalog changed ${shortHash(writeResult.previousHash)} → ${shortHash(writeResult.hash)}; cache updated at ${resolution.dir}`,
            ),
          );
        } else if (verbose) {
          logDiagnostic(
            chalk.dim(
              `windmill-ts: captured Hub catalog (${shortHash(writeResult.hash)}) at ${resolution.dir}`,
            ),
          );
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // A cache-persistence failure must not fail an otherwise valid online run;
      // the fresh response still drives this generation.
      logDiagnostic(
        chalk.yellow(
          `⚠️ Failed to persist Hub cache at ${resolution.dir} (${reason}); continuing without a cache write`,
        ),
      );
    }
  }

  // The fresh response is authoritative: never resurrect a removed type.
  const hubByName = new Map(
    fetched.types.map((record) => [record.name, record] as const),
  );
  const hubLayer = new Map<string, SourceResourceType>();
  for (const name of missing) {
    const record = hubByName.get(name);
    if (record) {
      hubLayer.set(name, hubToResourceType(record));
    }
  }

  const merged = mergeLayers(hubLayer, catalog, localDefs);
  const stillMissing = computeMissing(usedNames, merged);
  if (stillMissing.length > 0) {
    return failIncomplete(
      stillMissing,
      `The public Hub does not define them. Provide them via a committed source.resourceTypes.file catalog.`,
    );
  }

  return sortByName(merged);
};
