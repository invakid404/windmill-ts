import type { JSONSchema } from "../generator/types.js";

/**
 * The neutral data contract the generator consumes, independent of where the
 * metadata comes from (a live Windmill workspace or a local wmill-synced
 * folder). Only the fields the generator actually reads are modelled here.
 */

export type SourceSchemaItem = {
  path: string;
  schema?: JSONSchema;
};

export type SourceResource = {
  path: string;
  resource_type: string;
};

export type SourceResourceType = {
  name: string;
  schema?: JSONSchema;
  description?: string;
  format_extension?: string | null;
};

export type ResourceTypes = Map<string, SourceResourceType>;

export type WorkspaceResources = {
  /**
   * Paths of all resources in the workspace with a known resource type,
   * grouped by resource type.
   */
  resourcesByType: Map<string, string[]>;
  /** The resource type of every resource in the workspace, keyed by path. */
  pathToResourceType: Map<string, string>;
};

/**
 * The seam between the CLI and the generator. Both the remote (HTTP) and the
 * local (filesystem) implementations satisfy this exact contract.
 *
 * Contract notes:
 * - Every iterator invocation must be independent; generation tasks run
 *   concurrently and may each start their own iteration.
 * - Iterators must yield paths in ascending, POSIX-normalized order, and the
 *   resource-type map must be ordered by ascending name. This gives both
 *   sources a common deterministic ordering without the emission code caring.
 * - A provider must return fresh/deep-cloned schema/value objects when reused,
 *   because `schemaToZod()` mutates some schema nodes while repairing Windmill
 *   defaults/enums.
 */
export interface GenerationSource {
  readonly kind: "remote" | "local";
  listResourceTypes(): Promise<ResourceTypes>;
  listResources(): AsyncGenerator<SourceResource>;
  getResourceValue(path: string): Promise<unknown>;
  listScripts(): AsyncGenerator<SourceSchemaItem>;
  listFlows(): AsyncGenerator<SourceSchemaItem>;
}
