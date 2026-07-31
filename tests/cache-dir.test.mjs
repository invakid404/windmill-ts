import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";

import {
  CACHE_FILE_NAME,
  resolveCacheDir,
} from "../dist/src/source/local/cacheDir.js";

const sha16 = (input) =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

// A virtual filesystem/environment for the pure resolver.
const makeDeps = (opts) => {
  const exists = new Set(opts.exists ?? []);
  const dirs = new Set(opts.dirs ?? opts.exists ?? []);
  const writable = new Set(opts.writable ?? []);
  const pkg = new Set(opts.packageJson ?? []);
  const pkgWs = new Set(opts.packageJsonWorkspaces ?? []);
  const pnpm = new Set(opts.pnpmWorkspace ?? []);
  const git = new Set(opts.gitDir ?? []);
  const realpaths = opts.realpath ?? {};
  return {
    cwd: opts.cwd,
    env: opts.env ?? {},
    platform: opts.platform ?? "linux",
    homedir: opts.homedir ?? "/home/u",
    tmpdir: opts.tmpdir ?? "/tmp",
    pathExists: (p) => exists.has(p),
    isDirectory: (p) => dirs.has(p),
    isWritable: (p) => {
      let cur = p;
      while (true) {
        if (exists.has(cur)) return writable.has(cur);
        const parent = dirname(cur);
        if (parent === cur) return false;
        cur = parent;
      }
    },
    hasPackageJson: (d) => pkg.has(d),
    hasPackageJsonWorkspaces: (d) => pkgWs.has(d),
    hasPnpmWorkspace: (d) => pnpm.has(d),
    hasGitDir: (d) => git.has(d),
    realpath: (p) => realpaths[p] ?? p,
    sha256hex: (s) => createHash("sha256").update(s).digest("hex"),
  };
};

test("nearest package-local writable node_modules is chosen", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/proj/node_modules"],
    dirs: ["/proj", "/proj/node_modules"],
    writable: ["/proj/node_modules"],
    packageJson: ["/proj"],
    gitDir: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "node_modules");
  assert.equal(res.dir, "/proj/node_modules/.cache/windmill-ts");
});

test("a hoisted workspace node_modules is found without crossing the git root", () => {
  const deps = makeDeps({
    cwd: "/root/pkgs/a",
    exists: ["/root", "/root/pkgs", "/root/pkgs/a", "/root/node_modules", "/outside/node_modules"],
    dirs: ["/root", "/root/pkgs", "/root/pkgs/a", "/root/node_modules", "/outside/node_modules"],
    writable: ["/root/node_modules", "/outside/node_modules"],
    packageJson: ["/root/pkgs/a", "/root"],
    packageJsonWorkspaces: ["/root"],
    gitDir: ["/root"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.dir, "/root/node_modules/.cache/windmill-ts");
});

test("no node_modules falls back to a project-keyed OS cache", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/home/u", "/home/u/.cache"],
    dirs: ["/proj", "/home/u", "/home/u/.cache"],
    writable: ["/home/u/.cache", "/home/u"],
    packageJson: ["/proj"],
    gitDir: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "os");
  assert.equal(res.dir, `/home/u/.cache/windmill-ts/${sha16("/proj")}`);
});

test("read-only node_modules is skipped for the OS cache", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/proj/node_modules", "/home/u/.cache"],
    dirs: ["/proj", "/proj/node_modules", "/home/u/.cache"],
    writable: ["/home/u/.cache"], // node_modules NOT writable
    packageJson: ["/proj"],
    gitDir: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "os");
});

test("global/npx invocation with no package uses the OS cache", () => {
  const deps = makeDeps({
    cwd: "/tmp/npx-1234",
    exists: ["/tmp/npx-1234", "/home/u/.cache"],
    dirs: ["/tmp/npx-1234", "/home/u/.cache"],
    writable: ["/home/u/.cache"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "os");
  // projectRoot falls back to cwd when no package.json is found.
  assert.equal(res.dir, `/home/u/.cache/windmill-ts/${sha16("/tmp/npx-1234")}`);
});

test("XDG_CACHE_HOME, macOS, Windows, and Unix roots resolve as specified", () => {
  const key = sha16("/proj");
  const common = {
    cwd: "/proj",
    exists: ["/proj"],
    dirs: ["/proj"],
    packageJson: ["/proj"],
  };

  const xdg = resolveCacheDir(
    {},
    makeDeps({
      ...common,
      env: { XDG_CACHE_HOME: "/xdg" },
      exists: ["/proj", "/xdg"],
      writable: ["/xdg"],
    }),
  );
  assert.equal(xdg.dir, `/xdg/windmill-ts/${key}`);

  const mac = resolveCacheDir(
    {},
    makeDeps({
      ...common,
      platform: "darwin",
      homedir: "/Users/u",
      exists: ["/proj", "/Users/u/Library/Caches"],
      writable: ["/Users/u/Library/Caches"],
    }),
  );
  assert.equal(mac.dir, `/Users/u/Library/Caches/windmill-ts/${key}`);

  const win = resolveCacheDir(
    {},
    makeDeps({
      ...common,
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      exists: ["/proj", "C:\\Users\\u\\AppData\\Local"],
      writable: ["C:\\Users\\u\\AppData\\Local"],
    }),
  );
  assert.ok(win.dir.includes("windmill-ts"));
  assert.ok(win.dir.includes("Cache"));

  const unix = resolveCacheDir(
    {},
    makeDeps({
      ...common,
      homedir: "/home/u",
      exists: ["/proj", "/home/u/.cache"],
      writable: ["/home/u/.cache"],
    }),
  );
  assert.equal(unix.dir, `/home/u/.cache/windmill-ts/${key}`);
});

test("an unwritable OS cache falls back to temp", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/home/u", "/tmp"],
    dirs: ["/proj", "/home/u", "/tmp"],
    writable: ["/tmp"], // home/.cache not writable
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "temp");
  assert.equal(res.dir, `/tmp/windmill-ts/${sha16("/proj")}`);
});

test("no writable location yields a null cache directory", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj"],
    dirs: ["/proj"],
    writable: [],
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "none");
  assert.equal(res.dir, null);
});

test("different real roots get different keys; symlinks to one root share a key", () => {
  const base = {
    exists: ["/home/u/.cache"],
    dirs: ["/home/u/.cache"],
    writable: ["/home/u/.cache"],
  };
  const a = resolveCacheDir(
    {},
    makeDeps({ ...base, cwd: "/a", exists: [...base.exists, "/a"], packageJson: ["/a"] }),
  );
  const b = resolveCacheDir(
    {},
    makeDeps({ ...base, cwd: "/b", exists: [...base.exists, "/b"], packageJson: ["/b"] }),
  );
  assert.notEqual(a.dir, b.dir);

  const link = resolveCacheDir(
    {},
    makeDeps({
      ...base,
      cwd: "/link",
      exists: [...base.exists, "/link"],
      packageJson: ["/link"],
      realpath: { "/link": "/a" },
    }),
  );
  assert.equal(link.dir, a.dir);
});

test("an explicit writable override wins; an unwritable one errors", () => {
  const ok = resolveCacheDir(
    { override: "/w/cache" },
    makeDeps({ cwd: "/proj", exists: ["/w"], dirs: ["/w"], writable: ["/w"] }),
  );
  assert.equal(ok.kind, "override");
  assert.equal(ok.dir, "/w/cache");

  assert.throws(
    () =>
      resolveCacheDir(
        { override: "/ro/cache" },
        makeDeps({ cwd: "/proj", exists: ["/ro"], dirs: ["/ro"], writable: [] }),
      ),
    /not writable/,
  );
});

test("the cache file is versioned as resource-types-v1.json", () => {
  assert.equal(CACHE_FILE_NAME, "resource-types-v1.json");
});
