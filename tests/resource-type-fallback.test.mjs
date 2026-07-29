import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { schemaToZod } from "../dist/src/generator/common.js";
import { run } from "../dist/src/generator/context.js";

const argsSchema = (resourceType) => ({
  type: "object",
  properties: {
    arg: { type: "object", format: `resource-${resourceType}` },
  },
  required: ["arg"],
});

const withResources = (resourcesByType, cb) => {
  const output = new PassThrough();
  output.resume();

  const resourceTypes = new Map(
    [...resourcesByType.keys()].map((name) => [
      name,
      { name, schema: { type: "object", properties: {} } },
    ]),
  );

  return run(
    output,
    {
      outputDir: process.cwd(),
      resourceTypes,
      workspaceResources: { resourcesByType, pathToResourceType: new Map() },
    },
    cb,
  );
};

test("resource types without any resources fall back to z.any()", async () => {
  const result = await withResources(new Map(), () =>
    schemaToZod(argsSchema("record")),
  );

  assert.match(result, /"arg": z\.any\(\)/);
  assert.equal(result.includes("record_type"), false);
  assert.equal(result.includes("record_references"), false);
});

test("resource type names colliding with Object.prototype fall back too", async () => {
  for (const resourceType of ["constructor", "toString"]) {
    const result = await withResources(new Map(), () =>
      schemaToZod(argsSchema(resourceType)),
    );

    assert.match(result, /"arg": z\.any\(\)/);
  }
});

test("resource types with resources keep referring to their schemas", async () => {
  const result = await withResources(
    new Map([["record", ["f/app/record"]]]),
    () => schemaToZod(argsSchema("record")),
  );

  assert.match(result, /record_references/);
  assert.match(result, /record_type\.schema/);
});
