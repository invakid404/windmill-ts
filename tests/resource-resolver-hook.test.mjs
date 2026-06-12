import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ConfigSchema } from "../dist/src/config/schema.js";
import { __testing } from "../dist/src/generator/resources.js";

const makeTempDir = () =>
  mkdtemp(join(process.cwd(), ".tmp-windmill-ts-resolver-test-"));

const runTsc = (args) => {
  const tscPath = join(process.cwd(), "node_modules/typescript/bin/tsc");
  return spawnSync(process.execPath, [tscPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
};

const tscArgs = (...args) => [
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
  ...args,
];

const generatedClientSource = ({
  configuredResolver = false,
  transformer = "default",
} = {}) => {
  const preamble = __testing.getPreamble({
    embed: {
      enabled: true,
      resolveVariables: true,
      hasResourcesWithVars: true,
    },
    hasConfiguredResourceResolver: configuredResolver,
  });

  const transformerSource =
    transformer === "mark"
      ? `
        class _MarkingResourceTransformer implements Transformer {
          arg: unknown;
          do(value: Cast<(typeof this)["arg"], object>) {
            return { ...value, transformed: true };
          }
        }
        const _resourcesTransformer = _MarkingResourceTransformer;
      `
      : `
        class _DefaultResourceTransformer implements Transformer {
          arg: unknown
          do(value: Cast<(typeof this)["arg"], object>) {
            return value;
          }
        }
        const _resourcesTransformer = _DefaultResourceTransformer;
      `;

  return `
    import { z } from "zod";
    import * as wmill from "windmill-client";
    ${
      configuredResolver
        ? 'import { resolveResource as _configuredResourceResolver } from "./resolver.js";'
        : ""
    }

    const lazyObject = <T extends unknown>(fn: () => T) => {
      let instance: T | null = null;
      return new Proxy({}, {
        get(_target, prop) {
          if (instance == null) {
            instance = fn();
          }

          let value = (instance as any)[prop];
          if (value instanceof Function) {
            value = value.bind(instance);
          }

          return value;
        }
      }) as T;
    };

    ${transformerSource}

    ${preamble}

    async function _resolveVariables(obj: unknown): Promise<unknown> {
      if (typeof obj === "string" && obj.startsWith("$var:")) {
        return wmill.getVariable(obj.substring(5));
      }
      if (Array.isArray(obj)) {
        return Promise.all(obj.map(_resolveVariables));
      }
      if (obj != null && typeof obj === "object") {
        const entries = await Promise.all(
          Object.entries(obj).map(async ([k, v]) => [k, await _resolveVariables(v)] as const)
        );
        return Object.fromEntries(entries);
      }
      return obj;
    }

    const _embeddedResources = {
      "f/app/redis": {
        value: { host: "embedded", port: 6379 },
        hasVars: false,
      },
    } as const;

    const redis_type = lazyObject(() => ({
      name: "redis",
      schema: z.object({ host: z.string(), port: z.number() }),
    }));

    const resourceToType = lazyObject(() => ({
      "f/app/redis": redis_type,
    } as const));

    const pathsPerResourceType = lazyObject(() => ({
      "redis": ["f/app/redis"] as const,
    } as const));

    export type ResourceTypes = {
      "redis": z.infer<(typeof redis_type)["schema"]>,
    };

    export const defaultPerResourceType = {
      "redis": "f/app/redis",
    } as const;
  `;
};

const writeGeneratedFixture = async (
  tempDir,
  options,
  resolverSource = undefined,
) => {
  const sourcePath = join(tempDir, "generated-client.ts");
  await writeFile(sourcePath, generatedClientSource(options));

  if (resolverSource != null) {
    await writeFile(join(tempDir, "resolver.ts"), resolverSource);
  }

  return sourcePath;
};

const compileGeneratedFixture = async (
  tempDir,
  options,
  resolverSource = undefined,
) => {
  const sourcePath = await writeGeneratedFixture(
    tempDir,
    options,
    resolverSource,
  );
  const outDir = join(tempDir, "out");
  const result = runTsc(
    tscArgs("--outDir", outDir, sourcePath),
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return join(outDir, "generated-client.js");
};

test("config schema accepts a resource resolver hook import", () => {
  const config = ConfigSchema.parse({
    resources: {
      resolver: {
        importPath: "./windmill/resource-resolver",
        importName: "resolveResource",
        importExtension: ".js",
      },
    },
  });

  assert.deepEqual(config.resources.resolver, {
    importPath: "./windmill/resource-resolver",
    importName: "resolveResource",
    importExtension: ".js",
  });
});

test("config schema rejects empty resource hook import fields", () => {
  assert.throws(() =>
    ConfigSchema.parse({
      resources: {
        resolver: {
          importPath: "",
          importName: "resolveResource",
        },
      },
    }),
  );

  assert.throws(() =>
    ConfigSchema.parse({
      resources: {
        resolver: {
          importPath: "./resolver",
          importName: "",
        },
      },
    }),
  );
});

test("configured hook imports are relative to generated output", () => {
  const resolved = __testing.resolveConfiguredImport(
    {
      importPath: "./src/windmill/resource-resolver.ts",
      importName: "resolveResource",
      importExtension: ".js",
    },
    "/repo/generated",
    "/repo/windmill-ts.yaml",
  );

  assert.deepEqual(resolved, {
    importPath: "../src/windmill/resource-resolver.js",
    importName: "resolveResource",
  });
});

test("configured hook imports work when importPath has no extension", () => {
  const resolved = __testing.resolveConfiguredImport(
    {
      importPath: "./src/windmill/resource-resolver",
      importName: "resolveResource",
      importExtension: ".js",
    },
    "/repo/generated",
    "/repo/windmill-ts.yaml",
  );

  assert.deepEqual(resolved, {
    importPath: "../src/windmill/resource-resolver.js",
    importName: "resolveResource",
  });
});

test("configured hook imports preserve explicit extensions without override", () => {
  const resolved = __testing.resolveConfiguredImport(
    {
      importPath: "./src/windmill/resource-resolver.js",
      importName: "resolveResource",
    },
    "/repo/generated",
    "/repo/windmill-ts.yaml",
  );

  assert.deepEqual(resolved, {
    importPath: "../src/windmill/resource-resolver.js",
    importName: "resolveResource",
  });
});

test("configured hook imports normalize emitted specifiers to POSIX separators", () => {
  const resolved = __testing.resolveConfiguredImport(
    {
      importPath: ".\\resource-resolver.ts",
      importName: "resolveResource",
      importExtension: ".js",
    },
    "/repo/generated",
    "/repo/windmill-ts.yaml",
  );

  assert.equal(resolved?.importPath.includes("\\"), false);
});

test("generated resource preamble exposes and consults the resolver hook", () => {
  const preamble = __testing.getPreamble({
    embed: {
      enabled: false,
      resolveVariables: true,
      hasResourcesWithVars: false,
    },
    hasConfiguredResourceResolver: false,
  });

  assert.match(preamble, /export type ResourceResolverContext =/);
  assert.match(preamble, /export const setResourceResolver =/);
  assert.match(preamble, /export const getResourceResolver =/);
  assert.match(preamble, /const resolved = await resolver\(/);
  assert.match(
    preamble,
    /return resolved === undefined \? resolveDefault\(\) : resolved\.value;/,
  );
  assert.match(preamble, /_runtimeResourceResolver \?\? undefined/);
});

test("generated embedded helper keeps variable resolution before fallback", () => {
  const code = __testing.getEmbeddedResolverCode({
    enabled: true,
    resolveVariables: true,
    hasResourcesWithVars: true,
  });

  assert.match(code, /path in _embeddedResources/);
  assert.match(code, /entry\.hasVars \? await _resolveVariables/);
  assert.match(code, /structuredClone\(entry\.value\)/);
});

test("generated resolver preamble type-checks in a minimal client", async () => {
  const tempDir = await makeTempDir();

  try {
    const sourcePath = await writeGeneratedFixture(tempDir);
    const result = runTsc(tscArgs("--noEmit", sourcePath));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("generated resolver preamble type-checks with configured resolver import", async () => {
  const tempDir = await makeTempDir();

  try {
    const sourcePath = await writeGeneratedFixture(
      tempDir,
      { configuredResolver: true },
      `
        import type { ResourceResolver } from "./generated-client.js";

        export const resolveResource: ResourceResolver = () => ({
          value: { host: "configured", port: 6379 },
        });
      `,
    );
    const result = runTsc(tscArgs("--noEmit", sourcePath));
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("runtime resolver takes precedence and can no-op a configured resolver", async () => {
  const tempDir = await makeTempDir();

  try {
    const outputPath = await compileGeneratedFixture(
      tempDir,
      { configuredResolver: true },
      `
        export const resolveResource = () => ({
          value: { host: "configured", port: 1 },
        });
      `,
    );
    const client = await import(pathToFileURL(outputPath).href);

    assert.deepEqual(await client.getResource("f/app/redis"), {
      host: "configured",
      port: 1,
    });

    client.setResourceResolver(() =>
      client.resolvedResource({ host: "runtime", port: 2 }),
    );
    assert.deepEqual(await client.getResource("f/app/redis"), {
      host: "runtime",
      port: 2,
    });

    client.setResourceResolver(() => undefined);
    assert.deepEqual(await client.getResource("f/app/redis"), {
      host: "embedded",
      port: 6379,
    });

    client.setResourceResolver(undefined);
    assert.deepEqual(await client.getResource("f/app/redis"), {
      host: "configured",
      port: 1,
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("resolver output still validates and skipTransformer only skips transformer", async () => {
  const tempDir = await makeTempDir();

  try {
    const outputPath = await compileGeneratedFixture(tempDir, {
      transformer: "mark",
    });
    const client = await import(pathToFileURL(outputPath).href);

    let resolverCalls = 0;
    client.setResourceResolver(() => {
      resolverCalls++;
      return client.resolvedResource({ host: "runtime", port: 2 });
    });

    assert.deepEqual(await client.getResource("f/app/redis"), {
      host: "runtime",
      port: 2,
      transformed: true,
    });

    assert.deepEqual(
      await client.getResource("f/app/redis", { skipTransformer: true }),
      {
        host: "runtime",
        port: 2,
      },
    );
    assert.equal(resolverCalls, 2);

    client.setResourceResolver(() =>
      client.resolvedResource({ host: "invalid", port: "not-a-number" }),
    );
    await assert.rejects(() => client.getResource("f/app/redis"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
