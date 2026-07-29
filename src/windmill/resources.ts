import * as wmill from "windmill-client";
import type { ResourceTypes } from "./resourceTypes.js";

const PER_PAGE = 20;

/**
 * Fetches the raw (non-interpolated) value of a resource.
 * $var: references are NOT resolved — they remain as literal strings.
 */
export async function getResourceValue(path: string): Promise<unknown> {
  const workspace = process.env["WM_WORKSPACE"]!;
  return wmill.ResourceService.getResourceValue({ workspace, path });
}

export async function* listResources(resourceType?: string) {
  const workspace = process.env["WM_WORKSPACE"]!;

  for (let page = 1; ; ++page) {
    const pageData = await wmill.ResourceService.listResource({
      workspace,
      page,
      perPage: PER_PAGE,
      resourceTypeExclude: "cache,state,app_theme,app_custom",
      ...(resourceType != null && { resourceType }),
    });

    if (pageData.length === 0) {
      break;
    }

    yield* pageData;
  }
}

export type WorkspaceResources = {
  /**
   * Paths of all resources in the workspace with a known resource type,
   * grouped by resource type.
   */
  resourcesByType: Map<string, string[]>;
  /** The resource type of every resource in the workspace, keyed by path. */
  pathToResourceType: Map<string, string>;
};

export const collectWorkspaceResources = async (
  resourceTypes: ResourceTypes,
): Promise<WorkspaceResources> => {
  const resourcesByType = new Map<string, string[]>();
  const pathToResourceType = new Map<string, string>();

  for await (const {
    resource_type: resourceTypeName,
    path,
  } of listResources()) {
    pathToResourceType.set(path, resourceTypeName);

    if (!resourceTypes.has(resourceTypeName)) {
      continue;
    }

    const paths = resourcesByType.get(resourceTypeName);
    if (paths == null) {
      resourcesByType.set(resourceTypeName, [path]);
    } else {
      paths.push(path);
    }
  }

  return { resourcesByType, pathToResourceType };
};
