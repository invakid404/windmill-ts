import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as wmill from "windmill-client";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, "dist/src/index.js");
const FIXTURE = join(import.meta.dirname, "fixtures", "local-workspace");

const EMBED = ["  embed:", "    paths:", "      - f/demo/redis", "      - f/demo/file"];
const SPLIT_CONFIG = ["resources:", "  runtime: runtime.ts", ...EMBED, ""].join("\n");
const SINGLE_CONFIG = ["resources:", ...EMBED, ""].join("\n");

// generate() reads its config from process.cwd() once, so this file's
// in-process generation runs with the split config
const CONFIG_CWD = mkdtempSync(join(tmpdir(), "wmts-runtime-cfg-"));
writeFileSync(join(CONFIG_CWD, "windmill-ts.yaml"), SPLIT_CONFIG);
process.chdir(CONFIG_CWD);
process.on("exit", () => rmSync(CONFIG_CWD, { force: true, recursive: true }));

const { generate } = await import("../dist/src/generator/index.js");

const tsc = (args) =>
  spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/typescript/bin/tsc"),
      "--pretty",
      "false",
      "--ignoreConfig",
      "--target",
      "ESNext",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--allowImportingTsExtensions",
      "--rewriteRelativeImportExtensions",
      "--strict",
      "--skipLibCheck",
      "--types",
      "node",
      ...args,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );

// Generates from the local fixture with `config` into a directory under the
// repository (so the compiled client resolves windmill-client), compiles it and
// returns the compiled directory
const generateAndCompile = async (dir, config) => {
  await writeFile(join(dir, "windmill-ts.yaml"), config);
  const generated = spawnSync(
    process.execPath,
    [CLI, "--from-folder", FIXTURE, "--offline", "client.ts"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);

  const files = config === SPLIT_CONFIG ? ["client.ts", "runtime.ts"] : ["client.ts"];
  const compiled = tsc(["--outDir", join(dir, "out"), ...files.map((file) => join(dir, file))]);
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);

  return join(dir, "out");
};

const withRepoTempDir = async (fn) => {
  const dir = await mkdtemp(join(REPO_ROOT, ".tmp-windmill-ts-runtime-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

test("the runtime core holds no registry, and a resolver set through the client reaches it", async () => {
  await withRepoTempDir(async (dir) => {
    const out = await generateAndCompile(dir, SPLIT_CONFIG);

    const runtimeSource = await readFile(join(dir, "runtime.ts"), "utf8");
    assert.equal(runtimeSource.includes("f/demo/hello"), false);
    assert.equal(runtimeSource.includes("resourceToType"), false);
    assert.match(await readFile(join(dir, "client.ts"), "utf8"), /from "\.\/runtime\.ts";/);

    const client = await import(pathToFileURL(join(out, "client.js")).href);
    const runtime = await import(pathToFileURL(join(out, "runtime.js")).href);

    const redis = { host: "resolved", port: 1 };
    client.setResourceResolver(({ path }) =>
      path === "f/demo/redis" ? client.resolvedResource(redis) : undefined,
    );
    try {
      assert.deepEqual(await runtime.getResource("f/demo/redis"), redis);
      assert.deepEqual(await client.getResource("f/demo/redis"), redis);
      assert.deepEqual(await runtime.getDefaultResource("redis"), redis);
      assert.deepEqual(await runtime.getResource("f/demo/file"), {
        content: "inline file body\n",
      });
    } finally {
      client.setResourceResolver(undefined);
    }
  });
});

test("starting a job returns its id, and throws when Windmill refuses", async () => {
  let status = 200;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.statusCode = status;
      response.end(status === 200 ? "job-id" : "no such script");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  wmill.OpenAPI.BASE = `http://127.0.0.1:${server.address().port}`;
  process.env["WM_WORKSPACE"] = "test";

  try {
    await withRepoTempDir(async (dir) => {
      const clients = [];
      for (const [name, config] of [["single", SINGLE_CONFIG], ["split", SPLIT_CONFIG]]) {
        await mkdir(join(dir, name));
        const out = await generateAndCompile(join(dir, name), config);
        clients.push(await import(pathToFileURL(join(out, "client.js")).href));
      }

      for (const client of clients) {
        status = 200;
        assert.equal(await client.runScriptAsync("f/demo/hello", { name: "x" }), "job-id");
        assert.equal(await client.runFlowAsync("f/demo/flat", {}), "job-id");

        status = 404;
        await assert.rejects(
          client.runScriptAsync("f/demo/hello", { name: "x" }),
          /^Error: Failed to start Windmill script f\/demo\/hello: 404 Not Found - no such script$/,
        );
        await assert.rejects(
          client.runFlowAsync("f/demo/flat", {}),
          /^Error: Failed to start Windmill flow f\/demo\/flat: 404 Not Found - no such script$/,
        );
      }
    });
  } finally {
    server.close();
  }
});

test("output doesn't depend on the order the source lists things in", async () => {
  const source = (reverse) => {
    const order = (items) => (reverse ? items.toReversed() : items);
    const objectSchema = (properties) => ({ type: "object", properties, required: [] });

    return {
      kind: "remote",
      async listResourceTypes() {
        return new Map(
          order([
            ["file", { name: "file", schema: objectSchema({ content: { type: "string" } }) }],
            ["redis", { name: "redis", schema: objectSchema({ host: { type: "string" } }) }],
          ]),
        );
      },
      async *listResources() {
        yield* order([
          { path: "f/demo/file", resource_type: "file" },
          { path: "f/demo/redis", resource_type: "redis" },
          { path: "f/other/redis", resource_type: "redis" },
        ]);
      },
      async getResourceValue(path) {
        return path === "f/demo/file" ? { content: "x" } : { host: "localhost" };
      },
      async *listScripts() {
        yield* order([
          { path: "f/a/script", schema: objectSchema({ a: { type: "string" } }) },
          { path: "f/b/script", schema: objectSchema({ b: { type: "number" } }) },
        ]);
      },
      async *listFlows() {
        yield* order([
          { path: "f/a/flow", schema: objectSchema({}) },
          { path: "f/b/flow", schema: objectSchema({}) },
        ]);
      },
    };
  };

  const collect = (stream) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => (text += chunk));
    return () => text;
  };

  const generateFrom = async (reverse) => {
    const output = new PassThrough();
    const runtimeOutput = new PassThrough();
    const [client, runtime] = [collect(output), collect(runtimeOutput)];
    await generate(output, CONFIG_CWD, { source: source(reverse), runtimeOutput });
    return { client: client(), runtime: runtime() };
  };

  const forward = await generateFrom(false);
  assert.deepEqual(await generateFrom(true), forward);
  assert.ok(forward.client.indexOf('"f/a/script"') < forward.client.indexOf('"f/b/script"'));
});

test("the runtime core needs a file output of its own", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wmts-runtime-cli-"));
  const cli = (output) =>
    spawnSync(process.execPath, [CLI, "--from-folder", FIXTURE, "--offline", output], {
      cwd: dir,
      encoding: "utf8",
    });

  try {
    await writeFile(join(dir, "windmill-ts.yaml"), SPLIT_CONFIG);
    const toStdout = cli("-");
    assert.notEqual(toStdout.status, 0);
    assert.match(toStdout.stderr, /can't be stdout/);
    assert.equal(toStdout.stdout, "");

    await writeFile(join(dir, "windmill-ts.yaml"), SPLIT_CONFIG.replace("runtime.ts", "client.ts"));
    const toItself = cli("client.ts");
    assert.notEqual(toItself.status, 0);
    assert.match(toItself.stderr, /can't be the client's own output/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
