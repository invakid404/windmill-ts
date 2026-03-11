import * as wmill from "windmill-client";

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
