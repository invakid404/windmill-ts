import { lstat, opendir, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import type { MetadataFormat } from "./parsing.js";
import { compareStrings } from "../resources.js";

/**
 * True when a path relative to the source root escapes it. Only a leading
 * parent segment (`..`) or an absolute path counts as an escape; an in-root name
 * that merely begins with `..` (e.g. `..files/data.txt`) does not.
 */
export const escapesRoot = (rel: string): boolean =>
  rel === "" ||
  rel === ".." ||
  rel.startsWith(`..${nodePath.sep}`) ||
  nodePath.isAbsolute(rel);

export type MetadataKind = "script" | "flow" | "resource" | "resourceType";

export type DiscoveredFile = {
  kind: MetadataKind;
  format: MetadataFormat;
  /** Absolute path to the metadata file on disk. */
  absPath: string;
  /** Root-relative POSIX path of the metadata file. */
  relPath: string;
  /** Logical path (for scripts/flows/resources) or type name (resourceType). */
  logical: string;
};

type SuffixRule = {
  suffix: string;
  kind: MetadataKind;
  format: MetadataFormat;
  /** Only recognized at the source root (resource-type definitions in v1). */
  rootOnly?: boolean;
};

// Most specific suffixes first so a resource-type file is never mistaken for a
// resource. (`*.resource-type.yaml` does not end with `*.resource.yaml`, but
// ordering this way keeps the intent obvious.)
const FILE_RULES: readonly SuffixRule[] = [
  { suffix: ".resource-type.yaml", kind: "resourceType", format: "yaml", rootOnly: true },
  { suffix: ".resource-type.json", kind: "resourceType", format: "json", rootOnly: true },
  { suffix: ".script.yaml", kind: "script", format: "yaml" },
  { suffix: ".script.json", kind: "script", format: "json" },
  { suffix: ".resource.yaml", kind: "resource", format: "yaml" },
  { suffix: ".resource.json", kind: "resource", format: "json" },
  // Flat flow JSON form; the YAML form lives inside a `.flow`/`__flow` dir.
  { suffix: ".flow.json", kind: "flow", format: "json" },
];

// A flow's YAML form lives in a directory marked by one of these suffixes.
const FLOW_DIR_MARKERS = [".flow", "__flow"] as const;
const FLOW_DIR_FILES: readonly { file: string; format: MetadataFormat }[] = [
  { file: "flow.yaml", format: "yaml" },
  { file: "flow.json", format: "json" },
];

const matchFileRule = (name: string, isRoot: boolean): SuffixRule | undefined => {
  for (const rule of FILE_RULES) {
    if (name.endsWith(rule.suffix)) {
      if (rule.rootOnly && !isRoot) {
        return undefined;
      }
      return rule;
    }
  }
  return undefined;
};

const stripSuffix = (relPath: string, suffix: string): string =>
  relPath.slice(0, relPath.length - suffix.length);

/**
 * Assert that a symlinked metadata file resolves within the (real) source root.
 * Directory symlinks are never followed; only recognized metadata-file symlinks
 * reach this check.
 */
const assertContainedSymlink = async (
  absPath: string,
  relPath: string,
  realRoot: string,
): Promise<void> => {
  const real = await realpath(absPath);
  const rel = nodePath.relative(realRoot, real);
  if (escapesRoot(rel)) {
    throw new Error(
      `Metadata file ${relPath} is a symlink that escapes the source root`,
    );
  }
};

const collectFlowDir = async (
  absDir: string,
  relDir: string,
  marker: string,
  realRoot: string,
  out: DiscoveredFile[],
): Promise<void> => {
  const logical = stripSuffix(relDir, marker);
  for (const { file, format } of FLOW_DIR_FILES) {
    const absPath = nodePath.join(absDir, file);
    const relPath = `${relDir}/${file}`;

    // Use lstat so a symlinked flow.yaml/flow.json is detected rather than
    // silently followed by stat(), then apply the same realpath containment
    // check as ordinary metadata symlinks. Both candidates are still collected
    // so the cross-format duplicate check keeps firing.
    let stats;
    try {
      stats = await lstat(absPath);
    } catch {
      continue;
    }

    if (stats.isSymbolicLink()) {
      await assertContainedSymlink(absPath, relPath, realRoot);
    } else if (!stats.isFile()) {
      continue;
    }

    out.push({ kind: "flow", format, absPath, relPath, logical });
  }
};

const walk = async (
  absDir: string,
  relDir: string,
  realRoot: string,
  out: DiscoveredFile[],
): Promise<void> => {
  const dir = await opendir(absDir);
  for await (const dirent of dir) {
    const name = dirent.name;
    const childAbs = nodePath.join(absDir, name);
    const childRel = relDir ? `${relDir}/${name}` : name;
    const isRoot = relDir === "";

    if (dirent.isSymbolicLink()) {
      // Do not follow directory symlinks. A symlink whose name matches a
      // recognized metadata file is included only if it stays within the root.
      const rule = matchFileRule(name, isRoot);
      if (!rule) {
        continue;
      }
      await assertContainedSymlink(childAbs, childRel, realRoot);
      out.push({
        kind: rule.kind,
        format: rule.format,
        absPath: childAbs,
        relPath: childRel,
        logical: stripSuffix(childRel, rule.suffix),
      });
      continue;
    }

    if (dirent.isDirectory()) {
      const marker = FLOW_DIR_MARKERS.find((m) => name.endsWith(m));
      if (marker) {
        await collectFlowDir(childAbs, childRel, marker, realRoot, out);
        continue;
      }
      await walk(childAbs, childRel, realRoot, out);
      continue;
    }

    if (dirent.isFile()) {
      const rule = matchFileRule(name, isRoot);
      if (!rule) {
        continue;
      }
      out.push({
        kind: rule.kind,
        format: rule.format,
        absPath: childAbs,
        relPath: childRel,
        logical: stripSuffix(childRel, rule.suffix),
      });
    }
  }
};

/**
 * Recursively discover every recognized metadata file beneath `root`, returning
 * them sorted by relative path. Regular files are within the root by
 * construction (directory symlinks are never followed); metadata-file symlinks
 * are containment-checked.
 */
export const discover = async (
  root: string,
  realRoot: string,
): Promise<DiscoveredFile[]> => {
  const out: DiscoveredFile[] = [];
  await walk(root, "", realRoot, out);
  out.sort((a, b) => compareStrings(a.relPath, b.relPath));
  return out;
};
