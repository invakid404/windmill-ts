import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { JSONSchema } from "../../generator/types.js";
import type { SourceResourceType } from "../types.js";

export type MetadataFormat = "yaml" | "json";

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
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse ${format.toUpperCase()} metadata file ${relPath}: ${reason}`,
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
    schema: asOptionalSchema(result.data.schema, relPath, "schema"),
    description:
      typeof result.data.description === "string"
        ? result.data.description
        : undefined,
    format_extension: result.data.format_extension ?? null,
  };
};
