import type {
  GenerationSource,
  ResourceTypes,
  WorkspaceResources,
} from "./types.js";

/**
 * Resource types the generator never emits schemas for. The remote API is also
 * asked to exclude these server-side for efficiency, but the source-neutral
 * collector below must filter them regardless so both modes behave identically
 * (e.g. a local `f/app_custom/*.resource.yaml` never enters either inventory).
 */
export const EXCLUDED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "cache",
  "state",
  "app_theme",
  "app_custom",
]);

/**
 * Deterministic, locale-independent string comparison over UTF-16 code units.
 * Used to give both providers a stable path/name ordering contract.
 */
export const compareStrings = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Consumes a source's resource inventory and produces the two derived maps the
 * generator needs. This is source-neutral: it applies the shared exclusion
 * before writing either map, groups only known resource types, and sorts both
 * map keys and each path array so output is deterministic regardless of the
 * source's native enumeration order.
 */
export const collectWorkspaceResources = async (
  source: GenerationSource,
  resourceTypes: ResourceTypes,
): Promise<WorkspaceResources> => {
  const resourcesByType = new Map<string, string[]>();
  const pathToResourceType = new Map<string, string>();

  for await (const { path, resource_type } of source.listResources()) {
    if (EXCLUDED_RESOURCE_TYPES.has(resource_type)) {
      continue;
    }

    pathToResourceType.set(path, resource_type);

    if (!resourceTypes.has(resource_type)) {
      continue;
    }

    const paths = resourcesByType.get(resource_type);
    if (paths == null) {
      resourcesByType.set(resource_type, [path]);
    } else {
      paths.push(path);
    }
  }

  const sortedPathToResourceType = new Map(
    [...pathToResourceType.entries()].sort(([a], [b]) => compareStrings(a, b)),
  );

  const sortedResourcesByType = new Map(
    [...resourcesByType.entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(
        ([type, paths]) =>
          [type, [...paths].sort(compareStrings)] as [string, string[]],
      ),
  );

  return {
    resourcesByType: sortedResourcesByType,
    pathToResourceType: sortedPathToResourceType,
  };
};
