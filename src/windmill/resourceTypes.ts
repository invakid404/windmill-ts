import * as wmill from "windmill-client";

export const listResourceTypes = async () => {
  const workspace = process.env["WM_WORKSPACE"]!;

  const resourceTypes = await wmill.ResourceService.listResourceType({
    workspace,
  });

  // NOTE: a map rather than a plain object, as resource type names are
  //       arbitrary strings, and ones that collide with `Object.prototype`
  //       members (`constructor`, `toString`, ...) would otherwise be
  //       considered present when they aren't
  return new Map(
    resourceTypes.map((resourceType) => [resourceType.name, resourceType]),
  );
};

export type ResourceTypes = Awaited<ReturnType<typeof listResourceTypes>>;
