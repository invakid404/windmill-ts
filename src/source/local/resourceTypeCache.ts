import { createHash } from "node:crypto";
import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";
import { compareStrings } from "../resources.js";
import { CACHE_FILE_NAME } from "./cacheDir.js";
import { HUB_ENDPOINT, type HubResourceType } from "./hub.js";

export const CACHE_FORMAT_VERSION = 1 as const;

export type CachedResourceTypes = {
  formatVersion: typeof CACHE_FORMAT_VERSION;
  source: string;
  capturedAt: string;
  sha256: string;
  resourceTypes: HubResourceType[];
};

export type CacheReadResult =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; cache: CachedResourceTypes; hash: string };

const sortByName = (types: readonly HubResourceType[]): HubResourceType[] =>
  [...types].sort((a, b) => compareStrings(a.name, b.name));

/**
 * Canonical content hash over the name-sorted records. Schema key order is
 * preserved (not recursively sorted): a changed schema — including a reordered
 * one — is treated as drift, which is exactly what we want to surface.
 */
export const hashResourceTypes = (types: readonly HubResourceType[]): string => {
  const canonical = JSON.stringify(
    sortByName(types).map((type) => ({
      name: type.name,
      schema: type.schema,
      description: type.description ?? null,
      app: type.app ?? null,
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
};

const cacheFilePath = (dir: string): string =>
  nodePath.join(dir, CACHE_FILE_NAME);

/**
 * Read and integrity-check the cache. A missing file, unsupported format
 * version, malformed JSON, or a stored hash that no longer matches the payload
 * all yield a non-`ok` result; only a self-consistent v1 cache returns `ok`.
 */
export const readCache = async (dir: string): Promise<CacheReadResult> => {
  let content: string;
  try {
    content = await readFile(cacheFilePath(dir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "invalid", reason: "cache is not valid JSON" };
  }

  if (
    parsed == null ||
    typeof parsed !== "object" ||
    (parsed as { formatVersion?: unknown }).formatVersion !==
      CACHE_FORMAT_VERSION ||
    !Array.isArray((parsed as { resourceTypes?: unknown }).resourceTypes) ||
    typeof (parsed as { sha256?: unknown }).sha256 !== "string"
  ) {
    return { status: "invalid", reason: "unsupported cache shape or version" };
  }

  const cache = parsed as CachedResourceTypes;
  const recomputed = hashResourceTypes(cache.resourceTypes);
  if (recomputed !== cache.sha256) {
    return { status: "invalid", reason: "cache integrity hash mismatch" };
  }

  return { status: "ok", cache, hash: recomputed };
};

export type CacheWriteResult = {
  written: boolean;
  hash: string;
  previousHash?: string;
};

/**
 * Write the payload atomically (same-dir temp file + rename) only when its
 * canonical hash differs from what is already cached. An identical hash leaves
 * the existing file — including its `capturedAt` — byte-for-byte intact. A
 * failed write never destroys the prior cache.
 */
export const writeCacheIfChanged = async (
  dir: string,
  types: readonly HubResourceType[],
  capturedAt: string,
): Promise<CacheWriteResult> => {
  const hash = hashResourceTypes(types);

  const existing = await readCache(dir);
  if (existing.status === "ok" && existing.hash === hash) {
    return { written: false, hash, previousHash: existing.hash };
  }

  const payload: CachedResourceTypes = {
    formatVersion: CACHE_FORMAT_VERSION,
    source: HUB_ENDPOINT,
    capturedAt,
    sha256: hash,
    resourceTypes: sortByName(types),
  };

  await mkdir(dir, { recursive: true });
  const finalPath = cacheFilePath(dir);
  const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(payload, null, 2), "utf-8");
  await rename(tempPath, finalPath);

  return {
    written: true,
    hash,
    previousHash: existing.status === "ok" ? existing.hash : undefined,
  };
};
