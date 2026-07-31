import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(import.meta.dirname, "fixtures", "local-workspace");

// generate() reads config from process.cwd(); chdir to a temp dir carrying the
// embed config before the first generate() call in this (isolated) test process.
const CONFIG_CWD = mkdtempSync(join(tmpdir(), "wmts-parity-cfg-"));
writeFileSync(
  join(CONFIG_CWD, "windmill-ts.yaml"),
  ["resources:", "  embed:", "    paths:", "      - f/demo/redis", "      - f/demo/file", ""].join(
    "\n",
  ),
);
process.chdir(CONFIG_CWD);
process.on("exit", () => rmSync(CONFIG_CWD, { force: true, recursive: true }));

const { generate } = await import("../dist/src/generator/index.js");
const { createLocalSource } = await import(
  "../dist/src/source/local/index.js"
);

const SCHEMA_URL = "https://json-schema.org/draft/2020-12/schema";

const redisSchema = {
  $schema: SCHEMA_URL,
  type: "object",
  properties: {
    host: { type: "string" },
    port: { type: "number" },
    password: { type: "string" },
  },
  required: ["host"],
};
const fileSchema = {
  $schema: SCHEMA_URL,
  type: "object",
  properties: { content: { type: "string" } },
  required: ["content"],
};
const helloSchema = {
  $schema: SCHEMA_URL,
  type: "object",
  properties: {
    name: { type: "string" },
    db: { type: "object", format: "resource-redis" },
  },
  required: ["name"],
};
const dottedSchema = {
  $schema: SCHEMA_URL,
  type: "object",
  properties: { input1: { type: "string" } },
  required: [],
};
const flatSchema = {
  $schema: SCHEMA_URL,
  type: "object",
  properties: { input2: { type: "number" } },
  required: [],
};

// In-memory fake API provider carrying the same normalized data as the fixture.
const fakeApiSource = {
  kind: "remote",
  async listResourceTypes() {
    return new Map([
      [
        "file",
        {
          name: "file",
          schema: structuredClone(fileSchema),
          description: "A file resource type",
          format_extension: "txt",
        },
      ],
      [
        "redis",
        {
          name: "redis",
          schema: structuredClone(redisSchema),
          description: "",
          format_extension: null,
        },
      ],
    ]);
  },
  async *listResources() {
    yield { path: "f/demo/file", resource_type: "file" };
    yield { path: "f/demo/redis", resource_type: "redis" };
  },
  async getResourceValue(path) {
    if (path === "f/demo/redis") {
      return {
        host: "localhost",
        port: 6379,
        password: "$var:f/demo/redis_password",
        windmill_content_hash__: "hash-abc-123",
      };
    }
    if (path === "f/demo/file") {
      return { content: "inline file body\n" };
    }
    throw new Error(`unexpected embed path ${path}`);
  },
  async *listScripts() {
    yield { path: "f/demo/hello", schema: structuredClone(helloSchema) };
  },
  async *listFlows() {
    yield { path: "f/demo/dotted", schema: structuredClone(dottedSchema) };
    yield { path: "f/demo/flat", schema: structuredClone(flatSchema) };
  },
};

const generateToString = async (source) => {
  const out = new PassThrough();
  let buffer = "";
  out.setEncoding("utf8");
  out.on("data", (chunk) => {
    buffer += chunk;
  });
  await generate(out, CONFIG_CWD, { source, spinners: false });
  return buffer;
};

test("local and in-memory API providers generate byte-identical clients", async () => {
  const fromApi = await generateToString(fakeApiSource);
  const fromLocal = await generateToString(
    await createLocalSource({ folder: FIXTURE, hubMode: "offline" }),
  );

  assert.equal(
    fromLocal,
    fromApi,
    "local and API provider output should be byte-identical",
  );
});

test("generated client contains the expected surface and values", async () => {
  const output = await generateToString(
    await createLocalSource({ folder: FIXTURE, hubMode: "offline" }),
  );

  // Script/flow path unions (identifier suffix is toValidIdentifier-encoded).
  assert.match(output, /"f\/demo\/hello": scripts_/);
  assert.match(output, /"f\/demo\/dotted": flows_/);
  assert.match(output, /"f\/demo\/flat": flows_/);

  // Resource references/defaults use expected paths and types.
  assert.match(output, /"\$res:f\/demo\/redis"/);
  assert.match(output, /"redis": "f\/demo\/redis"/);
  assert.match(output, /"file": "f\/demo\/file"/);

  // Embedded values serialize correctly; !inline resolved; hash preserved.
  assert.match(output, /"content":"inline file body\\n"/);
  assert.match(output, /"windmill_content_hash__":"hash-abc-123"/);
  // $var: preserved and the runtime resolver helper emitted.
  assert.match(output, /"\$var:f\/demo\/redis_password"/);
  assert.match(output, /async function _resolveVariables/);

  // Ignored resources and unused resource types do not appear.
  assert.equal(output.includes("app_custom"), false);
  assert.equal(output.includes("f/cache/"), false);
});

const runTsc = (args, cwd) =>
  spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules/typescript/bin/tsc"), ...args],
    { cwd, encoding: "utf8" },
  );

test("generated client type-checks", async () => {
  const output = await generateToString(
    await createLocalSource({ folder: FIXTURE, hubMode: "offline" }),
  );

  const tempDir = await mkdtemp(join(REPO_ROOT, ".tmp-windmill-ts-parity-"));
  try {
    const sourcePath = join(tempDir, "generated-client.ts");
    await writeFile(sourcePath, output);
    const result = runTsc(
      [
        "--pretty",
        "false",
        "--ignoreConfig",
        "--target",
        "ESNext",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
        "--noEmit",
        sourcePath,
      ],
      REPO_ROOT,
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    if (existsSync(tempDir)) {
      await rm(tempDir, { force: true, recursive: true });
    }
  }
});
