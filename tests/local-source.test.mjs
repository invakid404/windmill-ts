import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLocalSource } from "../dist/src/source/local/index.js";
import {
  collectWorkspaceResources,
  EXCLUDED_RESOURCE_TYPES,
} from "../dist/src/source/resources.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "local-workspace");

const collect = async (gen) => {
  const out = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
};

const paths = (items) => items.map((i) => i.path);

// Write { relPath: content } under a fresh temp dir; returns the dir.
const makeTree = async (files) => {
  const dir = await mkdtemp(join(tmpdir(), "wmts-local-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
};

const OFFLINE = { hubMode: "offline" };

const withTree = async (files, fn) => {
  const dir = await makeTree(files);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
};

const REDIS_RT = `format_extension: null
schema:
  type: object
  properties:
    host: { type: string }
  required: [host]
`;

const FILE_RT = `format_extension: txt
schema:
  type: object
  properties:
    content: { type: string }
  required: [content]
`;

test("fixture inventory maps to expected logical paths", async () => {
  const source = await createLocalSource({ folder: FIXTURE, ...OFFLINE });

  assert.deepEqual(paths(await collect(source.listScripts())), ["f/demo/hello"]);
  assert.deepEqual(paths(await collect(source.listFlows())), [
    "f/demo/dotted",
    "f/demo/flat",
  ]);

  const rts = await source.listResourceTypes();
  assert.deepEqual([...rts.keys()].sort(), ["file", "redis"]);
});

test("resource inventories omit excluded types from both maps", async () => {
  const source = await createLocalSource({ folder: FIXTURE, ...OFFLINE });
  const rts = await source.listResourceTypes();
  const ws = await collectWorkspaceResources(source, rts);

  assert.deepEqual([...EXCLUDED_RESOURCE_TYPES].sort(), [
    "app_custom",
    "cache",
    "state",
    "app_theme",
  ].sort());

  const allPaths = [...ws.pathToResourceType.keys()];
  assert.equal(
    allPaths.some((p) => p.startsWith("f/app_custom/")),
    false,
  );
  assert.equal(
    allPaths.some((p) => p.startsWith("f/cache/")),
    false,
  );
  assert.deepEqual([...ws.resourcesByType.keys()].sort(), ["file", "redis"]);
});

test("iteration order is POSIX-sorted regardless of filesystem order", async () => {
  await withTree(
    {
      "f/z/last.script.yaml": "schema: { type: object, properties: {} }\n",
      "f/a/first.script.yaml": "schema: { type: object, properties: {} }\n",
      "f/m/mid.script.yaml": "schema: { type: object, properties: {} }\n",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      assert.deepEqual(paths(await collect(source.listScripts())), [
        "f/a/first",
        "f/m/mid",
        "f/z/last",
      ]);
    },
  );
});

test("JSON metadata maps to the same shapes as YAML", async () => {
  await withTree(
    {
      "redis.resource-type.json": JSON.stringify({
        format_extension: null,
        schema: { type: "object", properties: { host: { type: "string" } } },
      }),
      "f/demo/a.script.json": JSON.stringify({
        kind: "script",
        schema: { type: "object", properties: { x: { type: "string" } } },
      }),
      "f/demo/a.flow.json": JSON.stringify({
        schema: { type: "object", properties: { y: { type: "number" } } },
      }),
      "f/demo/a.resource.json": JSON.stringify({
        resource_type: "redis",
        value: { host: "h" },
      }),
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      const scripts = await collect(source.listScripts());
      const flows = await collect(source.listFlows());
      assert.deepEqual(paths(scripts), ["f/demo/a"]);
      assert.deepEqual(scripts[0].schema, {
        type: "object",
        properties: { x: { type: "string" } },
      });
      assert.deepEqual(paths(flows), ["f/demo/a"]);
      const rts = await source.listResourceTypes();
      assert.equal(rts.has("redis"), true);
      const resources = await collect(source.listResources());
      assert.deepEqual(resources, [
        { path: "f/demo/a", resource_type: "redis" },
      ]);
    },
  );
});

test("script metadata without a companion source file is valid", async () => {
  await withTree(
    { "f/demo/lonely.script.yaml": "schema: { type: object, properties: {} }\n" },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      assert.deepEqual(paths(await collect(source.listScripts())), [
        "f/demo/lonely",
      ]);
    },
  );
});

test("missing schema yields an item with undefined schema", async () => {
  await withTree(
    { "f/demo/noschema.script.yaml": "summary: hi\nkind: script\n" },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      const scripts = await collect(source.listScripts());
      assert.equal(scripts.length, 1);
      assert.equal(scripts[0].schema, undefined);
    },
  );
});

test("__flow directories and flat .flow.json both map correctly", async () => {
  await withTree(
    {
      "f/demo/nd__flow/flow.yaml": "schema: { type: object, properties: {} }\n",
      "f/demo/flat.flow.json": JSON.stringify({
        schema: { type: "object", properties: {} },
      }),
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      assert.deepEqual(paths(await collect(source.listFlows())), [
        "f/demo/flat",
        "f/demo/nd",
      ]);
    },
  );
});

test("cross-format duplicate scripts error with both filenames", async () => {
  await withTree(
    {
      "f/demo/dup.script.yaml": "schema: { type: object, properties: {} }\n",
      "f/demo/dup.script.json": JSON.stringify({ schema: { type: "object" } }),
    },
    async (dir) => {
      await assert.rejects(
        () => createLocalSource({ folder: dir, ...OFFLINE }),
        (err) =>
          /dup\.script\.json/.test(err.message) &&
          /dup\.script\.yaml/.test(err.message),
      );
    },
  );
});

test("duplicate flow representations error", async () => {
  await withTree(
    {
      "f/demo/x.flow/flow.yaml": "schema: { type: object, properties: {} }\n",
      "f/demo/x.flow.json": JSON.stringify({ schema: { type: "object" } }),
    },
    async (dir) => {
      await assert.rejects(() => createLocalSource({ folder: dir, ...OFFLINE }));
    },
  );
});

test("invalid metadata reports the relative filename", async () => {
  await withTree(
    { "f/demo/bad.resource.yaml": "resource_type: 123\nvalue: {}\n" },
    async (dir) => {
      await assert.rejects(
        () => createLocalSource({ folder: dir, ...OFFLINE }),
        (err) =>
          /bad\.resource\.yaml/.test(err.message) &&
          /resource_type/.test(err.message),
      );
    },
  );
});

test("malformed YAML reports the filename without echoing content", async () => {
  await withTree(
    { "f/demo/broken.script.yaml": "schema: {\n  bad: [unclosed\n" },
    async (dir) => {
      await assert.rejects(
        () => createLocalSource({ folder: dir, ...OFFLINE }),
        (err) => /broken\.script\.yaml/.test(err.message),
      );
    },
  );
});

test("wmill.yaml excludes and skip flags constrain discovery", async () => {
  const files = {
    "wmill.yaml":
      "includes: ['**']\nexcludes: ['f/skip/**']\nskipFlows: true\n",
    "f/keep/a.script.yaml": "schema: { type: object, properties: {} }\n",
    "f/skip/b.script.yaml": "schema: { type: object, properties: {} }\n",
    "f/keep/c.flow/flow.yaml": "schema: { type: object, properties: {} }\n",
  };
  await withTree(files, async (dir) => {
    const source = await createLocalSource({ folder: dir, ...OFFLINE });
    assert.deepEqual(paths(await collect(source.listScripts())), [
      "f/keep/a",
    ]);
    // skipFlows drops all flows.
    assert.deepEqual(paths(await collect(source.listFlows())), []);
  });
});

test("respectWmillYaml:false ignores wmill.yaml filters", async () => {
  const files = {
    "wmill.yaml": "includes: ['f/keep/**']\nexcludes: []\n",
    "f/keep/a.script.yaml": "schema: { type: object, properties: {} }\n",
    "f/other/b.script.yaml": "schema: { type: object, properties: {} }\n",
  };
  await withTree(files, async (dir) => {
    const scoped = await createLocalSource({ folder: dir, ...OFFLINE });
    assert.deepEqual(paths(await collect(scoped.listScripts())), ["f/keep/a"]);

    const literal = await createLocalSource({
      folder: dir,
      respectWmillYaml: false,
      ...OFFLINE,
    });
    assert.deepEqual(paths(await collect(literal.listScripts())), [
      "f/keep/a",
      "f/other/b",
    ]);
  });
});

test("resource-type files bypass include/exclude path globs", async () => {
  const files = {
    "wmill.yaml": "includes: ['f/**']\nexcludes: []\n",
    "redis.resource-type.yaml": REDIS_RT,
    "f/demo/r.resource.yaml": "resource_type: redis\nvalue: { host: h }\n",
  };
  await withTree(files, async (dir) => {
    // The root resource-type file is outside `f/**` but must still be loaded.
    const source = await createLocalSource({ folder: dir, ...OFFLINE });
    const rts = await source.listResourceTypes();
    assert.equal(rts.has("redis"), true);
  });
});

test("$var and $res values are preserved; content hash is not stripped", async () => {
  await withTree(
    {
      "redis.resource-type.yaml": REDIS_RT,
      "f/demo/r.resource.yaml":
        "resource_type: redis\nvalue:\n  host: '$res:f/other/thing'\n  password: '$var:f/secret'\n  windmill_content_hash__: keepme\n",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      const value = await source.getResourceValue("f/demo/r");
      assert.deepEqual(value, {
        host: "$res:f/other/thing",
        password: "$var:f/secret",
        windmill_content_hash__: "keepme",
      });
    },
  );
});

test("file resource !inline is substituted only when the type has format_extension", async () => {
  const source = await createLocalSource({ folder: FIXTURE, ...OFFLINE });
  const value = await source.getResourceValue("f/demo/file");
  assert.deepEqual(value, { content: "inline file body\n" });
});

test("!inline prefix on a non-file resource is left as ordinary data", async () => {
  await withTree(
    {
      "redis.resource-type.yaml": REDIS_RT,
      "f/demo/r.resource.yaml":
        "resource_type: redis\nvalue:\n  host: h\n  content: '!inline f/demo/should_not_read.txt'\n",
      "f/demo/should_not_read.txt": "SHOULD NOT BE READ",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      const value = await source.getResourceValue("f/demo/r");
      // redis has no format_extension, so the pointer stays literal.
      assert.equal(value.content, "!inline f/demo/should_not_read.txt");
    },
  );
});

test("missing !inline target is a filename-bearing hard error", async () => {
  await withTree(
    {
      "file.resource-type.yaml": FILE_RT,
      "f/demo/f.resource.yaml":
        "resource_type: file\nvalue:\n  content: '!inline f/demo/does_not_exist.txt'\n",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      await assert.rejects(
        () => source.getResourceValue("f/demo/f"),
        (err) => /does_not_exist\.txt/.test(err.message),
      );
    },
  );
});

test("absolute and .. escape !inline targets are rejected", async () => {
  await withTree(
    {
      "file.resource-type.yaml": FILE_RT,
      "f/demo/abs.resource.yaml":
        "resource_type: file\nvalue:\n  content: '!inline /etc/hosts'\n",
      "f/demo/esc.resource.yaml":
        "resource_type: file\nvalue:\n  content: '!inline ../../../etc/hosts'\n",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      await assert.rejects(
        () => source.getResourceValue("f/demo/abs"),
        /must be a relative path/,
      );
      await assert.rejects(
        () => source.getResourceValue("f/demo/esc"),
        /escapes the source root/,
      );
    },
  );
});

test("a recognized metadata symlink escaping the root is rejected", async () => {
  const outside = await mkdtemp(join(tmpdir(), "wmts-outside-"));
  await writeFile(
    join(outside, "evil.script.yaml"),
    "schema: { type: object, properties: {} }\n",
  );
  await withTree(
    { "f/demo/keep.script.yaml": "schema: { type: object, properties: {} }\n" },
    async (dir) => {
      await symlink(
        join(outside, "evil.script.yaml"),
        join(dir, "f/demo/link.script.yaml"),
      );
      await assert.rejects(
        () => createLocalSource({ folder: dir, ...OFFLINE }),
        /symlink that escapes the source root/,
      );
    },
  );
  await rm(outside, { force: true, recursive: true });
});

test("an unresolved used resource type fails offline with a sorted list", async () => {
  await withTree(
    {
      "f/demo/pg.resource.yaml": "resource_type: postgresql\nvalue: { host: h }\n",
      "f/demo/sl.resource.yaml": "resource_type: slack\nvalue: { token: t }\n",
    },
    async (dir) => {
      const cacheDir = await mkdtemp(join(tmpdir(), "wmts-empty-cache-"));
      try {
        await assert.rejects(
          () =>
            createLocalSource({
              folder: dir,
              hubMode: "offline",
              cacheDir,
              fetchImpl: async () => {
                throw new Error("fetch must not be called offline");
              },
            }),
          (err) =>
            /postgresql, slack/.test(err.message) &&
            /Unresolved resource types/.test(err.message),
        );
      } finally {
        await rm(cacheDir, { force: true, recursive: true });
      }
    },
  );
});

test("an unused local resource type definition is harmless", async () => {
  await withTree(
    {
      "redis.resource-type.yaml": REDIS_RT,
      "unused.resource-type.yaml":
        "format_extension: null\nschema: { type: object, properties: {} }\n",
      "f/demo/r.resource.yaml": "resource_type: redis\nvalue: { host: h }\n",
    },
    async (dir) => {
      const source = await createLocalSource({ folder: dir, ...OFFLINE });
      const rts = await source.listResourceTypes();
      assert.equal(rts.has("unused"), true);
      const ws = await collectWorkspaceResources(source, rts);
      // unused type has no instance, so it never enters the inventory.
      assert.equal(ws.resourcesByType.has("unused"), false);
    },
  );
});
