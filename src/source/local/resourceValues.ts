import { readFile, realpath } from "node:fs/promises";
import * as nodePath from "node:path";
import type { MetadataFormat } from "./parsing.js";
import { parseByFormat, parseResourceMetadata } from "./parsing.js";

export type ResourceEntry = {
  /** Logical resource path. */
  path: string;
  resource_type: string;
  absPath: string;
  relPath: string;
  format: MetadataFormat;
};

// Mirrors the wmill CLI's file-resource pointer convention.
const INLINE_PREFIX = "!inline ";

/**
 * Resolve an `!inline ` sibling-file pointer to a path contained beneath the
 * source root. Rejects absolute targets, lexical `..` escape, and (via realpath)
 * symlinks that escape the root. Mirrors the CLI's `/`→platform separator
 * normalization while adding containment safety the CLI does not perform.
 */
const resolveContainedTarget = async (
  target: string,
  realRoot: string,
  relPath: string,
): Promise<string> => {
  const normalized = target.split("/").join(nodePath.sep);

  if (nodePath.isAbsolute(normalized)) {
    throw new Error(
      `Inline file target ${JSON.stringify(target)} in resource ${relPath} must be a relative path`,
    );
  }

  const abs = nodePath.resolve(realRoot, normalized);
  const lexicalRel = nodePath.relative(realRoot, abs);
  if (lexicalRel.startsWith("..") || nodePath.isAbsolute(lexicalRel)) {
    throw new Error(
      `Inline file target ${JSON.stringify(target)} in resource ${relPath} escapes the source root`,
    );
  }

  let real: string;
  try {
    real = await realpath(abs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read inline file ${JSON.stringify(target)} referenced by resource ${relPath}: ${reason}`,
    );
  }

  const realRel = nodePath.relative(realRoot, real);
  if (realRel === "" || realRel.startsWith("..") || nodePath.isAbsolute(realRel)) {
    throw new Error(
      `Inline file target ${JSON.stringify(target)} in resource ${relPath} escapes the source root`,
    );
  }

  return real;
};

/**
 * If the resource is a file resource (its type has a non-empty `format_extension`)
 * whose `value.content` is a string beginning with `!inline `, substitute the
 * referenced sibling file's UTF-8 text for the pointer. Otherwise the value is
 * returned untouched — `$var:`/`$res:` strings and ordinary literals are never
 * interpreted here.
 */
const resolveInlineContent = async (
  value: unknown,
  realRoot: string,
  relPath: string,
  formatExtension: string | null | undefined,
): Promise<unknown> => {
  if (!formatExtension) {
    return value;
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const content = (value as Record<string, unknown>)["content"];
  if (typeof content !== "string" || !content.startsWith(INLINE_PREFIX)) {
    return value;
  }

  // Mirror the CLI's one-token convention: `content.split(" ")[1]`.
  const target = content.split(" ")[1];
  if (!target) {
    throw new Error(
      `Resource ${relPath} has an "!inline" pointer with no target path`,
    );
  }

  const resolved = await resolveContainedTarget(target, realRoot, relPath);
  const fileContent = await readFile(resolved, "utf-8");

  return { ...(value as Record<string, unknown>), content: fileContent };
};

/**
 * Lazily read, parse, and resolve a resource's raw value. The returned value is
 * deep-cloned so downstream mutation cannot corrupt the on-disk-derived data.
 */
export const readResourceValue = async (
  entry: ResourceEntry,
  realRoot: string,
  formatExtension: string | null | undefined,
): Promise<unknown> => {
  const content = await readFile(entry.absPath, "utf-8");
  const raw = parseByFormat(content, entry.format, entry.relPath);
  const { value } = parseResourceMetadata(raw, entry.relPath);

  const resolved = await resolveInlineContent(
    value,
    realRoot,
    entry.relPath,
    formatExtension,
  );

  return structuredClone(resolved);
};
