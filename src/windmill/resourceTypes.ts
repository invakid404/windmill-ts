import * as wmill from "windmill-client";

export const listResourceTypes = async () => {
  const workspace = process.env["WM_WORKSPACE"]!;

  const resourceTypes = await wmill.ResourceService.listResourceType({
    workspace,
  });

  return resourceTypes.reduce(
    (acc, resourceType) => ({
      ...acc,
      [resourceType.name]: resourceType,
    }),
    {} as Partial<Record<string, wmill.ResourceType>>,
  );
};
