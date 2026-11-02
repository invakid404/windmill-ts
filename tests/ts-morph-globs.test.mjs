import assert from "node:assert/strict";
import test from "node:test";
import { Project } from "ts-morph";

// @ts-morph/common's minimatch override must preserve the glob matching used
// by ts-morph's public API until upstream ships support for minimatch 11.
test("ts-morph selects source files with braces, globstars, and exclusions", () => {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const path of [
    "/src/main.ts",
    "/src/nested/helper.ts",
    "/src/nested/helper.test.ts",
    "/src/view.tsx",
    "/src/.hidden.ts",
    "/other/ignored.ts",
  ]) {
    project.createSourceFile(path, "");
  }

  const selected = project.getSourceFiles([
    "/src/**/*.{ts,tsx}",
    "!/src/**/*.test.ts",
  ]);
  assert.deepEqual(
    selected.map((file) => file.getFilePath()).sort(),
    ["/src/main.ts", "/src/nested/helper.ts", "/src/view.tsx"],
  );
});
