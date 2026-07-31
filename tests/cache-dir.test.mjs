import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import test from "node:test";

import {
  CACHE_FILE_NAME,
  ensureSecurePrivateDir,
  ensureSecureTempDir,
  resolveCacheDir,
} from "../dist/src/source/local/cacheDir.js";

const sha16 = (input) =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);

// A virtual filesystem/environment for the pure resolver.
const makeDeps = (opts) => {
  const exists = new Set(opts.exists ?? []);
  const dirs = new Set(opts.dirs ?? opts.exists ?? []);
  const writable = new Set(opts.writable ?? []);
  const privateDirs = new Set(opts.privateDirs ?? []);
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
    isPrivateDir: (p) => privateDirs.has(p),
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

test("a node_modules with a blocked (non-directory) .cache is skipped (S4)", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/proj/node_modules", "/proj/node_modules/.cache", "/home/u/.cache"],
    // .cache exists but is NOT a directory (a regular file blocks the target)
    dirs: ["/proj", "/proj/node_modules", "/home/u/.cache"],
    writable: ["/proj/node_modules", "/home/u/.cache"],
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

test("an unwritable OS cache falls back to a fresh temp root", () => {
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/home/u", "/tmp"],
    dirs: ["/proj", "/home/u", "/tmp"],
    writable: ["/tmp"], // home/.cache not writable; temp root does not exist yet
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "temp");
  assert.equal(res.dir, `/tmp/windmill-ts/${sha16("/proj")}`);
});

test("a private, current-user-owned pre-existing temp dir is reused (B3)", () => {
  const key = sha16("/proj");
  const tempDir = `/tmp/windmill-ts/${key}`;
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/tmp", "/tmp/windmill-ts", tempDir],
    dirs: ["/proj", "/tmp", "/tmp/windmill-ts", tempDir],
    writable: ["/tmp/windmill-ts", tempDir],
    privateDirs: ["/tmp/windmill-ts", tempDir],
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "temp");
  assert.equal(res.dir, tempDir);
});

test("a hostile (non-private) pre-created temp dir is refused (B3)", () => {
  const key = sha16("/proj");
  const tempDir = `/tmp/windmill-ts/${key}`;
  const deps = makeDeps({
    cwd: "/proj",
    exists: ["/proj", "/tmp", "/tmp/windmill-ts", tempDir],
    dirs: ["/proj", "/tmp", "/tmp/windmill-ts", tempDir],
    writable: ["/tmp/windmill-ts", tempDir],
    // NOT private (attacker-owned or loose perms) → must refuse.
    privateDirs: [],
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "none");
  assert.equal(res.dir, null);
});

test("a hostile shared temp root (symlink/non-private) is refused (B3)", () => {
  const key = sha16("/proj");
  const deps = makeDeps({
    cwd: "/proj",
    // The per-project child does not exist, but the shared root does and is
    // NOT private (e.g. a symlink or another user's dir) → refuse.
    exists: ["/proj", "/tmp", "/tmp/windmill-ts"],
    dirs: ["/proj", "/tmp", "/tmp/windmill-ts"],
    writable: ["/tmp/windmill-ts"],
    privateDirs: [],
    packageJson: ["/proj"],
  });
  const res = resolveCacheDir({}, deps);
  assert.equal(res.kind, "none");
  assert.equal(res.dir, null);
  // Sanity: the same layout with a private shared root would be usable.
  assert.equal(
    resolveCacheDir(
      {},
      makeDeps({
        cwd: "/proj",
        exists: ["/proj", "/tmp", "/tmp/windmill-ts"],
        dirs: ["/proj", "/tmp", "/tmp/windmill-ts"],
        writable: ["/tmp/windmill-ts"],
        privateDirs: ["/tmp/windmill-ts"],
        packageJson: ["/proj"],
      }),
    ).dir,
    `/tmp/windmill-ts/${key}`,
  );
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

test("an explicit writable override wins; unwritable/regular-file overrides error (S4)", () => {
  const ok = resolveCacheDir(
    { override: "/w/cache" },
    makeDeps({ cwd: "/proj", exists: ["/w"], dirs: ["/w"], writable: ["/w"] }),
  );
  assert.equal(ok.kind, "override");
  assert.equal(ok.dir, "/w/cache");

  // Parent writable but chosen path already exists as an unwritable directory.
  assert.throws(
    () =>
      resolveCacheDir(
        { override: "/ex" },
        makeDeps({ cwd: "/proj", exists: ["/ex"], dirs: ["/ex"], writable: [] }),
      ),
    /not a writable directory/,
  );

  // Override is a regular file, not a directory.
  assert.throws(
    () =>
      resolveCacheDir(
        { override: "/file" },
        makeDeps({ cwd: "/proj", exists: ["/file"], dirs: [], writable: ["/file"] }),
      ),
    /not a writable directory/,
  );

  // Non-existent target whose parent is unwritable.
  assert.throws(
    () =>
      resolveCacheDir(
        { override: "/ro/cache" },
        makeDeps({ cwd: "/proj", exists: ["/ro"], dirs: ["/ro"], writable: [] }),
      ),
    /not a writable directory/,
  );
});

test("the cache file is versioned as resource-types-v1.json", () => {
  assert.equal(CACHE_FILE_NAME, "resource-types-v1.json");
});

// --- T2-01: atomic secure temp-dir creation closes the check→create race ---

// A virtual filesystem where directory creation and lstat attributes are
// scriptable, so a hostile creation interleaved into the resolution→use gap can
// be simulated (not just pre-existing state).
const ME = 1000;
const makeSecureDeps = ({ preexisting = {}, uid = ME } = {}) => {
  const nodes = new Map(Object.entries(preexisting)); // path -> lstat-like attrs
  const created = [];
  const deps = {
    mkdir(path) {
      if (nodes.has(path)) {
        const err = new Error("EEXIST: file already exists");
        err.code = "EEXIST";
        throw err;
      }
      created.push(path);
      nodes.set(path, {
        isSymbolicLink: false,
        isDirectory: true,
        uid,
        mode: 0o700,
      });
    },
    lstat(path) {
      const st = nodes.get(path);
      if (!st) {
        const err = new Error("ENOENT: no such file or directory");
        err.code = "ENOENT";
        throw err;
      }
      return st;
    },
    getuid: () => uid,
  };
  return { deps, created, nodes };
};

const TMP_ROOT = "/tmp/windmill-ts";
const TMP_CHILD = "/tmp/windmill-ts/abc123";

test("both temp components absent → created privately (T2-01)", () => {
  const { deps, created } = makeSecureDeps();
  assert.equal(ensureSecureTempDir(TMP_CHILD, deps), true);
  assert.deepEqual(created, [TMP_ROOT, TMP_CHILD]);
});

test("a hostile dir created in the resolution→use gap is caught (T2-01 race)", () => {
  // At resolution the temp root was absent; an attacker wins the gap and
  // pre-creates a hostile shared root before our mkdir. mkdir → EEXIST, then
  // verification rejects it.
  for (const hostile of [
    { isSymbolicLink: true, isDirectory: false, uid: ME, mode: 0o700 }, // symlink
    { isSymbolicLink: false, isDirectory: true, uid: 31337, mode: 0o700 }, // other-owned
    { isSymbolicLink: false, isDirectory: true, uid: ME, mode: 0o777 }, // world-writable
    { isSymbolicLink: false, isDirectory: false, uid: ME, mode: 0o700 }, // not a dir
  ]) {
    const { deps, created } = makeSecureDeps({
      preexisting: { [TMP_ROOT]: hostile },
    });
    assert.equal(ensureSecureTempDir(TMP_CHILD, deps), false);
    // We must not have created the child under a hostile root.
    assert.equal(created.includes(TMP_CHILD), false);
  }
});

test("a hostile child under a safe root is caught (T2-01)", () => {
  const { deps } = makeSecureDeps({
    preexisting: {
      [TMP_ROOT]: { isSymbolicLink: false, isDirectory: true, uid: ME, mode: 0o700 },
      [TMP_CHILD]: { isSymbolicLink: true, isDirectory: false, uid: ME, mode: 0o700 },
    },
  });
  assert.equal(ensureSecureTempDir(TMP_CHILD, deps), false);
});

test("a pre-existing private dir owned by us is safely reused (T2-01)", () => {
  const priv = { isSymbolicLink: false, isDirectory: true, uid: ME, mode: 0o700 };
  const { deps, created } = makeSecureDeps({
    preexisting: { [TMP_ROOT]: priv, [TMP_CHILD]: priv },
  });
  assert.equal(ensureSecureTempDir(TMP_CHILD, deps), true);
  assert.deepEqual(created, []); // nothing (re)created
});

test("ensureSecurePrivateDir refuses a non-EEXIST mkdir failure (T2-01)", () => {
  const deps = {
    mkdir() {
      const err = new Error("EACCES: permission denied");
      err.code = "EACCES";
      throw err;
    },
    lstat() {
      throw new Error("should not be reached");
    },
    getuid: () => ME,
  };
  assert.equal(ensureSecurePrivateDir("/tmp/windmill-ts", deps), false);
});
