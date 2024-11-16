import * as wmill from "windmill-client";

const PER_PAGE = 20;

export async function* listResourcesByType(resourceType: string) {
  const workspace = process.env["WM_WORKSPACE"]!;

  for (let page = 1; ; ++page) {
    const pageData = await wmill.ResourceService.listResource({
      workspace,
      page,
      perPage: PER_PAGE,
      resourceType,
    });

    if (pageData.length === 0) {
      break;
    }

    yield* pageData;
  }
}
