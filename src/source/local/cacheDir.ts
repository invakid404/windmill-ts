import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import * as nodePath from "node:path";

/** The versioned cache filename stored inside the resolved directory. */
export const CACHE_FILE_NAME = "resource-types-v1.json";

export type CacheDirKind =
  | "override"
  | "node_modules"
  | "os"
  | "temp"
  | "none";

export type CacheDirResolution = {
  /** Absolute directory, or null when no persistent cache is possible. */
  dir: string | null;
  kind: CacheDirKind;
};

/**
 * Filesystem/platform/environment access abstracted so resolution can be tested
 * against fakes without touching a developer's real caches.
 */
export type CacheDirDeps = {
  cwd: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  tmpdir: string;
  pathExists(p: string): boolean;
  isDirectory(p: string): boolean;
  /** True if `dir` (or its nearest existing ancestor) is a writable directory. */
  isWritable(p: string): boolean;
  /**
   * True only if `p` is a real directory (not a symlink) owned by the current
   * user with no group/other permission bits — the safety gate for the shared
   * temp fallback root.
   */
  isPrivateDir(p: string): boolean;
  hasPackageJson(dir: string): boolean;
  hasPackageJsonWorkspaces(dir: string): boolean;
  hasPnpmWorkspace(dir: string): boolean;
  hasGitDir(dir: string): boolean;
  realpath(p: string): string;
  sha256hex(input: string): string;
};

export type CacheDirInput = {
  /** Absolute explicit override, or null/undefined to auto-resolve. */
  override?: string | null;
};

const ancestors = function* (start: string): Generator<string> {
  let current = start;
  while (true) {
    yield current;
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
};

const nearestAncestor = (
  start: string,
  pred: (dir: string) => boolean,
): string | undefined => {
  for (const dir of ancestors(start)) {
    if (pred(dir)) {
      return dir;
    }
  }
  return undefined;
};

const ancestorsUpToBoundary = (start: string, boundary: string): string[] => {
  const result: string[] = [];
  for (const dir of ancestors(start)) {
    result.push(dir);
    if (dir === boundary) {
      break;
    }
  }
  return result;
};

/**
 * A cache directory candidate is usable when — if it already exists — it is a
 * writable directory, or — if it does not exist — its nearest existing ancestor
 * is a writable directory we can create it under. This rejects an existing
 * regular file, an unwritable existing directory, and a blocked path component
 * (e.g. a `.cache` that is a file).
 */
const usableCacheTarget = (dir: string, deps: CacheDirDeps): boolean => {
  if (deps.pathExists(dir)) {
    return deps.isDirectory(dir) && deps.isWritable(dir);
  }
  for (const ancestor of ancestors(nodePath.dirname(dir))) {
    if (deps.pathExists(ancestor)) {
      return deps.isDirectory(ancestor) && deps.isWritable(ancestor);
    }
  }
  return false;
};

/**
 * The shared `<tmp>/windmill-ts` root is a squatting target on multi-user hosts.
 * Only reuse it (or its per-project child) when it is a private, current-user
 * -owned, non-symlink directory; otherwise refuse the temp fallback entirely.
 * When neither exists yet we create it ourselves with private (0700) mode.
 */
const isSafeTempCandidate = (dir: string, deps: CacheDirDeps): boolean => {
  if (deps.pathExists(dir)) {
    return deps.isPrivateDir(dir) && deps.isWritable(dir);
  }
  const sharedRoot = nodePath.dirname(dir); // <tmp>/windmill-ts
  if (deps.pathExists(sharedRoot)) {
    return deps.isPrivateDir(sharedRoot) && deps.isWritable(sharedRoot);
  }
  return deps.isWritable(deps.tmpdir);
};

const osCacheRoot = (deps: CacheDirDeps): string | null => {
  const xdg = deps.env["XDG_CACHE_HOME"];
  if (xdg) {
    return nodePath.join(xdg, "windmill-ts");
  }
  if (deps.platform === "darwin") {
    return nodePath.join(deps.homedir, "Library", "Caches", "windmill-ts");
  }
  if (deps.platform === "win32") {
    const localAppData =
      deps.env["LOCALAPPDATA"] ??
      nodePath.join(deps.homedir, "AppData", "Local");
    return nodePath.join(localAppData, "windmill-ts", "Cache");
  }
  return nodePath.join(deps.homedir, ".cache", "windmill-ts");
};

/**
 * Resolve the disposable cache directory in the documented precedence:
 *   1. explicit override (fails if unwritable — never silently relocates),
 *   2. nearest writable project/workspace `node_modules/.cache/windmill-ts`
 *      (bounded by the containing Git/workspace root; never creates node_modules),
 *   3. a project-keyed OS cache,
 *   4. a project-keyed temp directory,
 *   5. none (caller proceeds without persistence when possible).
 */
export const resolveCacheDir = (
  input: CacheDirInput,
  deps: CacheDirDeps,
): CacheDirResolution => {
  const override = input.override;
  if (override) {
    // An explicit override must resolve to a usable writable directory — an
    // existing unwritable dir or a regular file fails immediately (never
    // silently relocates).
    if (!usableCacheTarget(override, deps)) {
      throw new Error(
        `Configured cache directory ${override} is not a writable directory`,
      );
    }
    return { dir: override, kind: "override" };
  }

  const projectRoot =
    nearestAncestor(deps.cwd, (dir) => deps.hasPackageJson(dir)) ?? deps.cwd;

  const gitRoot = nearestAncestor(projectRoot, (dir) => deps.hasGitDir(dir));
  const workspaceRoot = nearestAncestor(
    projectRoot,
    (dir) => deps.hasPnpmWorkspace(dir) || deps.hasPackageJsonWorkspaces(dir),
  );
  const boundary = gitRoot ?? workspaceRoot ?? projectRoot;

  for (const dir of ancestorsUpToBoundary(projectRoot, boundary)) {
    const nodeModules = nodePath.join(dir, "node_modules");
    // Never create node_modules: it must already exist as a directory. The
    // `.cache/windmill-ts` target under it is then validated like any candidate.
    if (!deps.pathExists(nodeModules) || !deps.isDirectory(nodeModules)) {
      continue;
    }
    const target = nodePath.join(nodeModules, ".cache", "windmill-ts");
    if (usableCacheTarget(target, deps)) {
      return { dir: target, kind: "node_modules" };
    }
  }

  const projectKey = deps.sha256hex(deps.realpath(projectRoot)).slice(0, 16);

  const osRoot = osCacheRoot(deps);
  if (osRoot) {
    const osDir = nodePath.join(osRoot, projectKey);
    if (usableCacheTarget(osDir, deps)) {
      return { dir: osDir, kind: "os" };
    }
  }

  const tempDir = nodePath.join(deps.tmpdir, "windmill-ts", projectKey);
  if (isSafeTempCandidate(tempDir, deps)) {
    return { dir: tempDir, kind: "temp" };
  }

  return { dir: null, kind: "none" };
};

const nearestExisting = (p: string): string | undefined => {
  for (const dir of ancestors(p)) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return undefined;
};

/**
 * Filesystem operations for the atomic secure-directory creation used by the
 * shared temp fallback. Injectable so the create/verify race can be tested with
 * a hostile creation interleaved into the check→use gap.
 */
export type SecureDirDeps = {
  /** Create `path` non-recursively with `mode`; throws `{code:'EEXIST'}` if it exists. */
  mkdir(path: string, mode: number): void;
  /** lstat (does NOT follow symlinks); throws if the path is missing. */
  lstat(path: string): {
    isSymbolicLink: boolean;
    isDirectory: boolean;
    uid: number;
    mode: number;
  };
  /** Current effective uid, or undefined where unavailable (e.g. Windows). */
  getuid(): number | undefined;
};

/**
 * Atomically create `dir` (non-recursively) with mode 0700. If it already
 * exists (`EEXIST`), verify it is a non-symlink directory owned by the current
 * user with no group/other permission bits. This closes the check→create TOCTOU
 * race: an attacker who wins the gap and pre-creates a hostile directory is
 * caught here (mkdir yields EEXIST, then verification fails). Returns true iff
 * the directory now exists and is private to us.
 */
export const ensureSecurePrivateDir = (
  dir: string,
  deps: SecureDirDeps,
): boolean => {
  try {
    deps.mkdir(dir, 0o700);
    // We created it exclusively, so it is ours and private by construction.
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      return false;
    }
    // Someone else already created it (possibly in the race window) — verify it
    // is a private directory owned by us before trusting it.
    try {
      const st = deps.lstat(dir);
      if (st.isSymbolicLink || !st.isDirectory) {
        return false;
      }
      const uid = deps.getuid();
      if (uid != null && st.uid !== uid) {
        return false;
      }
      if ((st.mode & 0o077) !== 0) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }
};

/**
 * Securely create/verify the full shared-temp chain (`<tmp>/windmill-ts` then
 * the per-project child) so both components are private-to-us before any cache
 * read or write. Returns true iff the whole chain is now safe.
 */
export const ensureSecureTempDir = (
  tempDir: string,
  deps: SecureDirDeps,
): boolean =>
  ensureSecurePrivateDir(nodePath.dirname(tempDir), deps) &&
  ensureSecurePrivateDir(tempDir, deps);

/** Real filesystem-backed {@link SecureDirDeps}. */
export const defaultSecureDirDeps = (): SecureDirDeps => ({
  mkdir: (path, mode) => {
    mkdirSync(path, { mode });
  },
  lstat: (path) => {
    const st = lstatSync(path);
    return {
      isSymbolicLink: st.isSymbolicLink(),
      isDirectory: st.isDirectory(),
      uid: st.uid,
      mode: st.mode,
    };
  },
  getuid: () => process.getuid?.(),
});

/** Real filesystem/OS-backed deps for production use. */
export const defaultCacheDirDeps = (
  cwd: string = process.cwd(),
): CacheDirDeps => ({
  cwd,
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  tmpdir: tmpdir(),
  pathExists: (p) => existsSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isWritable: (p) => {
    const existing = nearestExisting(p);
    if (!existing) {
      return false;
    }
    try {
      // Directories need write (create entries) and execute/search (traverse).
      accessSync(existing, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isPrivateDir: (p) => {
    try {
      // lstat, so a symlink is rejected (isDirectory() is false for a link).
      const st = lstatSync(p);
      if (!st.isDirectory()) {
        return false;
      }
      const getuid = process.getuid?.bind(process);
      if (getuid) {
        // POSIX: must be owned by us with no group/other bits (0700-style).
        if (st.uid !== getuid() || (st.mode & 0o077) !== 0) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  },
  hasPackageJson: (dir) => existsSync(nodePath.join(dir, "package.json")),
  hasPackageJsonWorkspaces: (dir) => {
    try {
      const pkg = JSON.parse(
        readFileSync(nodePath.join(dir, "package.json"), "utf-8"),
      );
      return pkg != null && "workspaces" in pkg;
    } catch {
      return false;
    }
  },
  hasPnpmWorkspace: (dir) =>
    existsSync(nodePath.join(dir, "pnpm-workspace.yaml")),
  hasGitDir: (dir) => existsSync(nodePath.join(dir, ".git")),
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
  sha256hex: (input) => createHash("sha256").update(input).digest("hex"),
});
