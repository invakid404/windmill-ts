import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
  /** True if `dir` (or its nearest existing ancestor) is writable. */
  isWritable(p: string): boolean;
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
    const parent = nodePath.dirname(override);
    const writable =
      (deps.pathExists(override) && deps.isWritable(override)) ||
      deps.isWritable(parent);
    if (!writable) {
      throw new Error(
        `Configured cache directory ${override} is not writable`,
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
    if (
      deps.pathExists(nodeModules) &&
      deps.isDirectory(nodeModules) &&
      deps.isWritable(nodeModules)
    ) {
      return {
        dir: nodePath.join(nodeModules, ".cache", "windmill-ts"),
        kind: "node_modules",
      };
    }
  }

  const projectKey = deps.sha256hex(deps.realpath(projectRoot)).slice(0, 16);

  const osRoot = osCacheRoot(deps);
  if (osRoot) {
    const osDir = nodePath.join(osRoot, projectKey);
    if (deps.isWritable(osDir)) {
      return { dir: osDir, kind: "os" };
    }
  }

  const tempDir = nodePath.join(deps.tmpdir, "windmill-ts", projectKey);
  if (deps.isWritable(tempDir)) {
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
      accessSync(existing, constants.W_OK);
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
