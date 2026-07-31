import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchHubResourceTypes,
  HUB_ENDPOINT,
  normalizeHubResponse,
} from "../dist/src/source/local/hub.js";
import { composeResourceTypes } from "../dist/src/source/local/resourceTypes.js";
import {
  hashResourceTypes,
  readCache,
  writeCacheIfChanged,
} from "../dist/src/source/local/resourceTypeCache.js";

const CACHE_FILE = "resource-types-v1.json";

const rtSchema = (name) => ({
  type: "object",
  properties: { [`${name}_key`]: { type: "string" } },
  required: [],
});

const hubRecord = (name, opts = {}) => ({
  id: 1,
  name,
  schema: "schema" in opts ? opts.schema : JSON.stringify(rtSchema(name)),
  description: opts.description ?? "",
  app: opts.app ?? name,
});

const jsonResponse = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const mockFetch = (records, capture) => async (url, init) => {
  capture?.push({ url, init });
  return jsonResponse(records);
};

const withCacheDir = async (fn) => {
  const dir = await mkdtemp(join(tmpdir(), "wmts-cache-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const baseParams = (over = {}) => ({
  localDefs: new Map(),
  usedNames: new Set(),
  resourceTypesFile: null,
  cacheDir: null,
  hubMode: "online",
  verbose: false,
  root: "/tmp/root",
  fetchImpl: undefined,
  ...over,
});

const captureStderr = async (fn) => {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
};

test("fetch targets the exact public endpoint with no credentials", async () => {
  const capture = [];
  await fetchHubResourceTypes({
    fetchImpl: mockFetch([hubRecord("postgresql")], capture),
  });
  assert.equal(capture.length, 1);
  const { url, init } = capture[0];
  assert.equal(url, HUB_ENDPOINT);
  assert.equal(url.includes("?"), false);
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Accept, "application/json");
  assert.equal("authorization" in init.headers, false);
  assert.equal("Authorization" in init.headers, false);
  assert.equal("cookie" in init.headers, false);
  assert.equal(init.body, undefined);
});

test("normalizeHubResponse parses JSON-string schemas, sorts, and omits invalid", () => {
  const result = normalizeHubResponse([
    hubRecord("zed"),
    hubRecord("alpha"),
    hubRecord("null_schema", { schema: null }),
    hubRecord("bad_json", { schema: "{not json" }),
  ]);
  assert.deepEqual(
    result.types.map((t) => t.name),
    ["alpha", "zed"],
  );
  assert.deepEqual(result.types[0].schema, rtSchema("alpha"));
  assert.deepEqual(result.omitted, ["bad_json", "null_schema"]);
});

test("normalizeHubResponse rejects duplicate names and wrong shapes", () => {
  assert.throws(
    () => normalizeHubResponse([hubRecord("dup"), hubRecord("dup")]),
    /duplicate resource type name/,
  );
  assert.throws(
    () => normalizeHubResponse({ not: "an array" }),
    /Unexpected Hub response shape/,
  );
});

test("complete local composition avoids fetch and cache entirely", async () => {
  let fetchCalls = 0;
  const localDefs = new Map([
    ["redis", { name: "redis", schema: rtSchema("redis"), format_extension: null }],
  ]);
  const result = await composeResourceTypes(
    baseParams({
      localDefs,
      usedNames: new Set(["redis"]),
      cacheDir: "/nonexistent/should-not-be-touched",
      fetchImpl: async () => {
        fetchCalls++;
        throw new Error("fetch must not be called");
      },
    }),
  );
  assert.equal(fetchCalls, 0);
  assert.equal(result.get("redis").schema.type, "object");
});

test("every online invocation fetches, even when the cache is already complete", async () => {
  await withCacheDir(async (cacheDir) => {
    const capture = [];
    const params = baseParams({
      usedNames: new Set(["postgresql"]),
      cacheDir,
      fetchImpl: mockFetch([hubRecord("postgresql")], capture),
    });
    await composeResourceTypes(params);
    await composeResourceTypes(params);
    assert.equal(capture.length, 2);
  });
});

test("offline never fetches and errors when incomplete", async () => {
  await withCacheDir(async (cacheDir) => {
    let fetchCalls = 0;
    await assert.rejects(
      () =>
        composeResourceTypes(
          baseParams({
            usedNames: new Set(["postgresql"]),
            cacheDir,
            hubMode: "offline",
            fetchImpl: async () => {
              fetchCalls++;
              throw new Error("should not fetch");
            },
          }),
        ),
      /Unresolved resource types.*postgresql/s,
    );
    assert.equal(fetchCalls, 0);
  });
});

test("offline resolves from a valid cache without fetching", async () => {
  await withCacheDir(async (cacheDir) => {
    // Seed the cache online.
    await composeResourceTypes(
      baseParams({
        usedNames: new Set(["postgresql"]),
        cacheDir,
        fetchImpl: mockFetch([hubRecord("postgresql")]),
      }),
    );
    let fetchCalls = 0;
    const result = await composeResourceTypes(
      baseParams({
        usedNames: new Set(["postgresql"]),
        cacheDir,
        hubMode: "offline",
        fetchImpl: async () => {
          fetchCalls++;
          throw new Error("no fetch offline");
        },
      }),
    );
    assert.equal(fetchCalls, 0);
    assert.equal(result.get("postgresql").schema.type, "object");
  });
});

test("identical fresh content does not rewrite the cache; changed content does", async () => {
  await withCacheDir(async (cacheDir) => {
    const records = [hubRecord("postgresql")];
    await composeResourceTypes(
      baseParams({ usedNames: new Set(["postgresql"]), cacheDir, fetchImpl: mockFetch(records) }),
    );
    const first = await readFile(join(cacheDir, CACHE_FILE), "utf-8");

    // Identical response → byte-identical cache (same capturedAt).
    await composeResourceTypes(
      baseParams({ usedNames: new Set(["postgresql"]), cacheDir, fetchImpl: mockFetch(records) }),
    );
    const second = await readFile(join(cacheDir, CACHE_FILE), "utf-8");
    assert.equal(first, second);

    // Changed schema → drift reported and cache replaced.
    const changed = [hubRecord("postgresql", { schema: JSON.stringify({ type: "object", properties: { other: { type: "number" } }, required: [] }) })];
    const { lines } = await captureStderr(() =>
      composeResourceTypes(
        baseParams({ usedNames: new Set(["postgresql"]), cacheDir, fetchImpl: mockFetch(changed) }),
      ),
    );
    const third = await readFile(join(cacheDir, CACHE_FILE), "utf-8");
    assert.notEqual(second, third);
    assert.ok(lines.some((l) => /Hub catalog changed/.test(l)));
  });
});

test("refresh failure with a sufficient cache warns and continues", async () => {
  await withCacheDir(async (cacheDir) => {
    await composeResourceTypes(
      baseParams({ usedNames: new Set(["postgresql"]), cacheDir, fetchImpl: mockFetch([hubRecord("postgresql")]) }),
    );
    const before = await readFile(join(cacheDir, CACHE_FILE), "utf-8");

    const { result, lines } = await captureStderr(() =>
      composeResourceTypes(
        baseParams({
          usedNames: new Set(["postgresql"]),
          cacheDir,
          fetchImpl: async () => {
            throw new Error("network down");
          },
        }),
      ),
    );
    assert.equal(result.get("postgresql").schema.type, "object");
    assert.ok(lines.some((l) => /Hub refresh failed/.test(l)));
    // Cache left byte-for-byte intact on stale fallback.
    const after = await readFile(join(cacheDir, CACHE_FILE), "utf-8");
    assert.equal(before, after);
  });
});

test("refresh failure without a sufficient cache is fatal", async () => {
  await withCacheDir(async (cacheDir) => {
    await assert.rejects(
      () =>
        composeResourceTypes(
          baseParams({
            usedNames: new Set(["postgresql"]),
            cacheDir,
            fetchImpl: async () => {
              throw new Error("network down");
            },
          }),
        ),
      /Unresolved resource types.*postgresql/s,
    );
  });
});

test("a fresh response is authoritative: a removed type is not resurrected", async () => {
  await withCacheDir(async (cacheDir) => {
    await composeResourceTypes(
      baseParams({
        usedNames: new Set(["postgresql", "slack"]),
        cacheDir,
        fetchImpl: mockFetch([hubRecord("postgresql"), hubRecord("slack")]),
      }),
    );
    // Next run: Hub no longer returns slack, but slack is still used.
    await assert.rejects(
      () =>
        composeResourceTypes(
          baseParams({
            usedNames: new Set(["postgresql", "slack"]),
            cacheDir,
            fetchImpl: mockFetch([hubRecord("postgresql")]),
          }),
        ),
      /Unresolved resource types.*slack/s,
    );
  });
});

test("precedence is local > catalog > hub", async () => {
  await withCacheDir(async (cacheDir) => {
    const catalogFile = join(cacheDir, "catalog.json");
    await writeFile(
      catalogFile,
      JSON.stringify([
        { name: "shared", schema: { type: "object", properties: { via: { type: "string" } }, required: [] } },
        { name: "catalog_only", schema: { type: "object", properties: { c: { type: "string" } }, required: [] } },
      ]),
    );
    const localDefs = new Map([
      ["shared", { name: "shared", schema: { type: "object", properties: { local: { type: "string" } }, required: [] }, format_extension: null }],
    ]);
    const capture = [];
    const result = await composeResourceTypes(
      baseParams({
        localDefs,
        usedNames: new Set(["shared", "catalog_only", "hub_only"]),
        resourceTypesFile: catalogFile,
        cacheDir,
        fetchImpl: mockFetch(
          [
            hubRecord("shared", { schema: JSON.stringify({ type: "object", properties: { hub: { type: "string" } }, required: [] }) }),
            hubRecord("hub_only"),
          ],
          capture,
        ),
      }),
    );
    // shared resolves from local (highest precedence).
    assert.deepEqual(Object.keys(result.get("shared").schema.properties), ["local"]);
    // catalog_only from catalog.
    assert.deepEqual(Object.keys(result.get("catalog_only").schema.properties), ["c"]);
    // hub_only from the hub.
    assert.equal(result.get("hub_only").schema.type, "object");
  });
});

test("a complete supplemental catalog avoids the Hub entirely", async () => {
  await withCacheDir(async (cacheDir) => {
    const catalogFile = join(cacheDir, "catalog.json");
    await writeFile(
      catalogFile,
      JSON.stringify([{ name: "postgresql", schema: rtSchema("postgresql") }]),
    );
    let fetchCalls = 0;
    const result = await composeResourceTypes(
      baseParams({
        usedNames: new Set(["postgresql"]),
        resourceTypesFile: catalogFile,
        cacheDir,
        fetchImpl: async () => {
          fetchCalls++;
          throw new Error("must not fetch");
        },
      }),
    );
    assert.equal(fetchCalls, 0);
    assert.equal(result.get("postgresql").schema.type, "object");
  });
});

test("a torn cache is refetched online and rebuilt", async () => {
  await withCacheDir(async (cacheDir) => {
    await writeFile(join(cacheDir, CACHE_FILE), "{ not valid json");
    const capture = [];
    const result = await composeResourceTypes(
      baseParams({
        usedNames: new Set(["postgresql"]),
        cacheDir,
        fetchImpl: mockFetch([hubRecord("postgresql")], capture),
      }),
    );
    assert.equal(capture.length, 1);
    assert.equal(result.get("postgresql").schema.type, "object");
    const cache = await readCache(cacheDir);
    assert.equal(cache.status, "ok");
  });
});

test("a cache-persistence failure does not fail an otherwise valid online run", async () => {
  await withCacheDir(async (cacheDir) => {
    // Make the target cache filename a directory so the atomic rename fails.
    await mkdir(join(cacheDir, CACHE_FILE), { recursive: true });
    const { result, lines } = await captureStderr(() =>
      composeResourceTypes(
        baseParams({
          usedNames: new Set(["postgresql"]),
          cacheDir,
          fetchImpl: mockFetch([hubRecord("postgresql")]),
        }),
      ),
    );
    assert.equal(result.get("postgresql").schema.type, "object");
    assert.ok(lines.some((l) => /Failed to persist Hub cache/.test(l)));
  });
});

test("readCache rejects an integrity-hash mismatch", async () => {
  await withCacheDir(async (cacheDir) => {
    await writeFile(
      join(cacheDir, CACHE_FILE),
      JSON.stringify({
        formatVersion: 1,
        source: HUB_ENDPOINT,
        capturedAt: "2026-01-01T00:00:00.000Z",
        sha256: "deadbeef",
        resourceTypes: [{ name: "x", schema: { type: "object" } }],
      }),
    );
    const cache = await readCache(cacheDir);
    assert.equal(cache.status, "invalid");
  });
});

test("writeCacheIfChanged is atomic and content-addressed", async () => {
  await withCacheDir(async (cacheDir) => {
    const types = [{ name: "a", schema: { type: "object" }, description: null, app: "a" }];
    const first = await writeCacheIfChanged(cacheDir, types, "2026-01-01T00:00:00.000Z");
    assert.equal(first.written, true);
    const second = await writeCacheIfChanged(cacheDir, types, "2026-02-02T00:00:00.000Z");
    assert.equal(second.written, false);
    assert.equal(hashResourceTypes(types), first.hash);
  });
});

const retryFetch = (sequence) => {
  let i = 0;
  return async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  };
};

test("transient 5xx is retried; non-retryable 4xx is not", async () => {
  const ok = jsonResponse([hubRecord("postgresql")]);
  const result = await fetchHubResourceTypes({
    fetchImpl: retryFetch([
      new Response("", { status: 503 }),
      ok,
    ]),
    minTimeoutMs: 1,
    maxTimeoutMs: 2,
  });
  assert.equal(result.types.length, 1);

  await assert.rejects(
    () =>
      fetchHubResourceTypes({
        fetchImpl: retryFetch([new Response("", { status: 404 })]),
        retries: 3,
        minTimeoutMs: 1,
      }),
    /HTTP 404/,
  );
});

test("malformed JSON from the Hub is an error", async () => {
  await assert.rejects(
    () =>
      fetchHubResourceTypes({
        fetchImpl: async () =>
          new Response("<<not json>>", { status: 200 }),
        retries: 0,
      }),
  );
});
