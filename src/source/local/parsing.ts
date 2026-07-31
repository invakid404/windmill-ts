import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { JSONSchema } from "../../generator/types.js";
import type { SourceResourceType } from "../types.js";

export type MetadataFormat = "yaml" | "json";

/**
 * Describe a YAML/JSON parse failure using only structured, content-free
 * location data (error code, line/column, or byte position). The underlying
 * parser messages embed the offending source line — which may contain a resource
 * secret — so they are NEVER interpolated into an error.
 */
export const describeParseLocation = (err: unknown): string => {
  // The `yaml` library exposes a structured, content-free location + code.
  const linePos = (err as { linePos?: Array<{ line: number; col: number }> })
    .linePos;
  const code = (err as { code?: string }).code;
  if (Array.isArray(linePos) && linePos[0]) {
    const codePart = typeof code === "string" ? ` [${code}]` : "";
    return `${codePart} at line ${linePos[0].line}, column ${linePos[0].col}`;
  }
  // JSON SyntaxError: extract ONLY numeric location, never the message snippet
  // (Node's message can quote the surrounding source, i.e. a secret).
  const message = err instanceof Error ? err.message : "";
  const lineCol = message.match(/line (\d+) column (\d+)/i);
  if (lineCol) {
    return ` at line ${lineCol[1]}, column ${lineCol[2]}`;
  }
  const position = message.match(/position (\d+)/i);
  if (position) {
    return ` at position ${position[1]}`;
  }
  return "";
};

/**
 * Parse a metadata document by its declared format. Errors are filename-rich
 * and never echo the parsed document, since resource values may hold secrets.
 * The quoted `!inline ` prefix used by file resources is an ordinary YAML/JSON
 * string, so no custom parser configuration is required.
 */
export const parseByFormat = (
  content: string,
  format: MetadataFormat,
  relPath: string,
): unknown => {
  try {
    if (format === "json") {
      return JSON.parse(content);
    }
    // The `yaml` library bounds alias expansion (maxAliasCount) by default,
    // which guards against alias bombs.
    return parseYaml(content);
  } catch (err) {
    throw new Error(
      `Failed to parse ${format.toUpperCase()} metadata file ${relPath}${describeParseLocation(err)}`,
    );
  }
};

const describeFailure = (
  kind: string,
  relPath: string,
  error: z.ZodError,
): string => {
  const issue = error.issues[0];
  const at = issue?.path?.length ? issue.path.join(".") : "(root)";
  // NOTE: only the field path and Zod's type-level message are surfaced; the
  //       received value is deliberately never included.
  return `Invalid ${kind} metadata in ${relPath} at ${at}: ${issue?.message ?? "validation failed"}`;
};

/**
 * Validate that a value is a JSON-Schema-like object without rebuilding it, so
 * the original key order and Windmill extensions are preserved untouched.
 */
const asOptionalSchema = (
  value: unknown,
  relPath: string,
  field: string,
): JSONSchema | undefined => {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Invalid ${field} in ${relPath}: expected a JSON Schema object`,
    );
  }
  return value as JSONSchema;
};

/**
 * Like {@link asOptionalSchema} but the schema is mandatory: an explicit
 * resource-type definition must carry an object-valued `schema` (a missing,
 * null, array, or scalar schema is a filename-rich hard error).
 */
export const asRequiredSchema = (
  value: unknown,
  relPath: string,
  field: string,
): JSONSchema => {
  if (value == null) {
    throw new Error(
      `Missing ${field} in ${relPath}: a resource type must define an object ${field}`,
    );
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Invalid ${field} in ${relPath}: expected a JSON Schema object`,
    );
  }
  return value as JSONSchema;
};

// `z.unknown()` passes the original reference through untouched, so schema and
// value objects keep their exact key order and Windmill extensions.
const ScriptMetadataSchema = z.object({ schema: z.unknown().optional() });
const FlowMetadataSchema = z.object({ schema: z.unknown().optional() });
const ResourceMetadataSchema = z.object({
  resource_type: z.string().min(1),
  value: z.unknown().optional(),
  description: z.unknown().optional(),
});
const ResourceTypeMetadataSchema = z.object({
  schema: z.unknown().optional(),
  description: z.unknown().optional(),
  format_extension: z.union([z.string(), z.null()]).optional(),
});

export const parseScriptMetadata = (
  raw: unknown,
  relPath: string,
): { schema?: JSONSchema } => {
  const result = ScriptMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(describeFailure("script", relPath, result.error));
  }
  return { schema: asOptionalSchema(result.data.schema, relPath, "schema") };
};

export const parseFlowMetadata = (
  raw: unknown,
  relPath: string,
): { schema?: JSONSchema } => {
  const result = FlowMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(describeFailure("flow", relPath, result.error));
  }
  return { schema: asOptionalSchema(result.data.schema, relPath, "schema") };
};

export type ParsedResource = {
  resource_type: string;
  value: unknown;
};

export const parseResourceMetadata = (
  raw: unknown,
  relPath: string,
): ParsedResource => {
  const result = ResourceMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(describeFailure("resource", relPath, result.error));
  }
  return {
    resource_type: result.data.resource_type,
    value: result.data.value,
  };
};

export const parseResourceTypeMetadata = (
  raw: unknown,
  relPath: string,
  name: string,
): SourceResourceType => {
  const result = ResourceTypeMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(describeFailure("resource type", relPath, result.error));
  }
  return {
    name,
    schema: asRequiredSchema(result.data.schema, relPath, "schema"),
    description:
      typeof result.data.description === "string"
        ? result.data.description
        : undefined,
    format_extension: result.data.format_extension ?? null,
  };
};
