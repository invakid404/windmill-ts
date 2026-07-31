import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, readFile, rm, writeFile } from "node:fs/promises";
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

/**
 * Fully validate a parsed v1 cache payload and every record, so no malformed
 * entry can reach `hashResourceTypes()` and throw. Returns a value-safe reason
 * (never source content) when the payload is unusable.
 */
const validateCachePayload = (
  parsed: unknown,
): { ok: true } | { ok: false; reason: string } => {
  if (!isRecord(parsed)) {
    return { ok: false, reason: "cache is not a JSON object" };
  }
  if (parsed["formatVersion"] !== CACHE_FORMAT_VERSION) {
    return { ok: false, reason: "unsupported cache format version" };
  }
  if (typeof parsed["source"] !== "string") {
    return { ok: false, reason: "missing or invalid source" };
  }
  if (typeof parsed["capturedAt"] !== "string") {
    return { ok: false, reason: "missing or invalid capturedAt" };
  }
  if (typeof parsed["sha256"] !== "string") {
    return { ok: false, reason: "missing or invalid sha256" };
  }
  if (!Array.isArray(parsed["resourceTypes"])) {
    return { ok: false, reason: "resourceTypes is not an array" };
  }
  for (const record of parsed["resourceTypes"]) {
    if (!isRecord(record)) {
      return { ok: false, reason: "a resource type record is not an object" };
    }
    if (typeof record["name"] !== "string" || record["name"].length === 0) {
      return { ok: false, reason: "a resource type record has an invalid name" };
    }
    const schema = record["schema"];
    if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
      return {
        ok: false,
        reason: `resource type ${JSON.stringify(record["name"])} has a non-object schema`,
      };
    }
    if (record["description"] != null && typeof record["description"] !== "string") {
      return {
        ok: false,
        reason: `resource type ${JSON.stringify(record["name"])} has an invalid description`,
      };
    }
    if (record["app"] != null && typeof record["app"] !== "string") {
      return {
        ok: false,
        reason: `resource type ${JSON.stringify(record["name"])} has an invalid app`,
      };
    }
  }
  return { ok: true };
};

/**
 * Read and integrity-check the cache. A missing file, unsupported format
 * version, malformed JSON/record, or a stored hash that no longer matches the
 * payload all yield a non-`ok` result; only a fully-validated, self-consistent
 * v1 cache returns `ok`.
 */
export const readCache = async (dir: string): Promise<CacheReadResult> => {
  let content: string;
  try {
    content = await readFile(cacheFilePath(dir), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    // Value-safe: surface only the error code, never a raw message/content.
    const code = (err as NodeJS.ErrnoException).code ?? "read error";
    return { status: "invalid", reason: `cache read failed (${code})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "invalid", reason: "cache is not valid JSON" };
  }

  const validation = validateCachePayload(parsed);
  if (!validation.ok) {
    return { status: "invalid", reason: validation.reason };
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

  // The temp fallback chain is pre-created 0700 by ensureSecureTempDir; other
  // kinds live in user-owned locations. A recursive mkdir is a no-op for the
  // former and safe for the latter.
  await mkdir(dir, { recursive: true });
  const finalPath = cacheFilePath(dir);
  // A random, exclusively-created (`wx`) temp name avoids same-process collisions
  // between concurrent writers; the atomic rename keeps last-writer-wins across
  // processes, and the `finally` removes any residue from a failed write/rename.
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
    await rename(tempPath, finalPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }

  return {
    written: true,
    hash,
    previousHash: existing.status === "ok" ? existing.hash : undefined,
  };
};
