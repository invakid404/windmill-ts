import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ConfigSchema } from "../dist/src/config/schema.js";
import { __testing } from "../dist/src/generator/resources.js";

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
  const tempDir = await mkdtemp(
    join(process.cwd(), ".tmp-windmill-ts-resolver-test-"),
  );
  const sourcePath = join(tempDir, "generated-client.ts");

  const preamble = __testing.getPreamble({
    embed: {
      enabled: true,
      resolveVariables: true,
      hasResourcesWithVars: true,
    },
    hasConfiguredResourceResolver: false,
  });

  const source = `
    import { z } from "zod";
    import * as wmill from "windmill-client";

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

    class _DefaultResourceTransformer implements Transformer {
      arg: unknown
      do(value: Cast<(typeof this)["arg"], object>) {
        return value;
      }
    }
    const _resourcesTransformer = _DefaultResourceTransformer;

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
        value: { host: "$var:f/app/redis_host", port: 6379 },
        hasVars: true,
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

  try {
    await writeFile(sourcePath, source);

    const tscPath = join(process.cwd(), "node_modules/typescript/bin/tsc");
    const result = spawnSync(
      process.execPath,
      [
        tscPath,
        "--pretty",
        "false",
        "--ignoreConfig",
        "--noEmit",
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
        sourcePath,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
