import assert from "node:assert/strict";
import test from "node:test";
import * as wmill from "windmill-client";

import { remoteSource } from "../dist/src/source/remote.js";
import { resolveSourceSelection } from "../dist/src/source/options.js";

const collect = async (gen) => {
  const out = [];
  for await (const item of gen) out.push(item);
  return out;
};

// --- remote provider delegation -------------------------------------------

test("remoteSource.listResources keeps the exclusion filter and sorts by path", async () => {
  process.env["WM_WORKSPACE"] = "test-ws";
  const calls = [];
  const original = wmill.ResourceService.listResource;
  wmill.ResourceService.listResource = async (params) => {
    calls.push(params);
    if (params.page === 1) {
      return [
        { path: "f/b", resource_type: "redis" },
        { path: "f/a", resource_type: "redis" },
      ];
    }
    return [];
  };
  try {
    const items = await collect(remoteSource.listResources());
    assert.deepEqual(
      items.map((i) => i.path),
      ["f/a", "f/b"],
    );
    // The exclusion's meaning is the SET of four types, not their comma order.
    assert.deepEqual(
      new Set(calls[0].resourceTypeExclude.split(",")),
      new Set(["cache", "state", "app_theme", "app_custom"]),
    );
  } finally {
    wmill.ResourceService.listResource = original;
  }
});

test("remoteSource.listResourceTypes returns a name-sorted neutral map", async () => {
  process.env["WM_WORKSPACE"] = "test-ws";
  const original = wmill.ResourceService.listResourceType;
  wmill.ResourceService.listResourceType = async () => [
    { name: "redis", schema: { type: "object" }, description: "r", format_extension: null },
    { name: "aaa", schema: { type: "object" }, description: "a" },
  ];
  try {
    const rts = await remoteSource.listResourceTypes();
    assert.deepEqual([...rts.keys()], ["aaa", "redis"]);
    assert.equal(rts.get("redis").name, "redis");
  } finally {
    wmill.ResourceService.listResourceType = original;
  }
});

test("remoteSource.listScripts pages summaries, fetches details, and sorts", async () => {
  process.env["WM_WORKSPACE"] = "test-ws";
  const origList = wmill.ScriptService.listScripts;
  const origDetail = wmill.ScriptService.getScriptByPath;
  wmill.ScriptService.listScripts = async ({ page }) =>
    page === 1 ? [{ path: "f/z" }, { path: "f/a" }] : [];
  wmill.ScriptService.getScriptByPath = async ({ path }) => ({
    path,
    schema: { type: "object", properties: { [path]: { type: "string" } } },
  });
  try {
    const items = await collect(remoteSource.listScripts());
    assert.deepEqual(
      items.map((i) => i.path),
      ["f/a", "f/z"],
    );
    assert.ok(items[0].schema);
  } finally {
    wmill.ScriptService.listScripts = origList;
    wmill.ScriptService.getScriptByPath = origDetail;
  }
});

test("remoteSource.getResourceValue delegates to ResourceService.getResourceValue", async () => {
  process.env["WM_WORKSPACE"] = "test-ws";
  const original = wmill.ResourceService.getResourceValue;
  let received;
  wmill.ResourceService.getResourceValue = async (params) => {
    received = params;
    return { host: "h" };
  };
  try {
    const value = await remoteSource.getResourceValue("f/demo/redis");
    assert.deepEqual(value, { host: "h" });
    assert.equal(received.path, "f/demo/redis");
    assert.equal(received.workspace, "test-ws");
  } finally {
    wmill.ResourceService.getResourceValue = original;
  }
});

// --- mode/path precedence (pure) ------------------------------------------

const config = (over = {}) => ({
  configPath: "/proj/windmill-ts.yaml",
  source: undefined,
  ...over,
});

test("--from-folder and --workspace together is a usage error", () => {
  assert.throws(
    () => resolveSourceSelection({ fromFolder: "./w", workspace: "x" }, config(), "/cwd"),
    /cannot be used together/,
  );
});

test("explicit --from-folder selects local and resolves against cwd", () => {
  const sel = resolveSourceSelection({ fromFolder: "./w" }, config(), "/cwd");
  assert.equal(sel.mode, "local");
  assert.equal(sel.folder, "/cwd/w");
});

test("explicit --workspace selects remote even with a configured folder", () => {
  const sel = resolveSourceSelection(
    { workspace: "prod" },
    config({ source: { folder: "./w", respectWmillYaml: true, resourceTypes: { hub: { mode: "online" } } } }),
    "/cwd",
  );
  assert.equal(sel.mode, "remote");
  assert.equal(sel.workspace, "prod");
});

test("config source.folder selects local and resolves against the config dir", () => {
  const sel = resolveSourceSelection(
    {},
    config({ source: { folder: "./w", respectWmillYaml: false, cacheDir: "./c", resourceTypes: { file: "./cat.json", hub: { mode: "offline" } } } }),
    "/cwd",
  );
  assert.equal(sel.mode, "local");
  assert.equal(sel.folder, "/proj/w");
  assert.equal(sel.respectWmillYaml, false);
  assert.equal(sel.cacheDir, "/proj/c");
  assert.equal(sel.resourceTypesFile, "/proj/cat.json");
  assert.equal(sel.hubMode, "offline");
});

test("no selector and no source.folder falls back to remote", () => {
  const sel = resolveSourceSelection({}, config(), "/cwd");
  assert.equal(sel.mode, "remote");
});

test("CLI paths override config paths and resolve against cwd; --offline wins", () => {
  const sel = resolveSourceSelection(
    { fromFolder: "./w", cacheDir: "./cli-cache", resourceTypesFile: "./cli-cat.json", offline: true },
    config({ source: { folder: "./ignored", respectWmillYaml: true, cacheDir: "./cfg", resourceTypes: { file: "./cfg.json", hub: { mode: "online" } } } }),
    "/cwd",
  );
  assert.equal(sel.folder, "/cwd/w");
  assert.equal(sel.cacheDir, "/cwd/cli-cache");
  assert.equal(sel.resourceTypesFile, "/cwd/cli-cat.json");
  assert.equal(sel.hubMode, "offline");
});

test("local-only options in remote mode throw", () => {
  for (const cli of [{ offline: true }, { cacheDir: "./c" }, { resourceTypesFile: "./f.json" }]) {
    assert.throws(
      () => resolveSourceSelection(cli, config(), "/cwd"),
      /only valid in local mode/,
    );
  }
});
