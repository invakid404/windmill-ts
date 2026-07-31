import * as wmill from "windmill-client";
import type { JSONSchema } from "../generator/types.js";
import type { ResourceTypes, SourceResourceType } from "../source/types.js";
import { compareStrings } from "../source/resources.js";

export type { ResourceTypes };

export const listResourceTypes = async (): Promise<ResourceTypes> => {
  const workspace = process.env["WM_WORKSPACE"]!;

  const resourceTypes = await wmill.ResourceService.listResourceType({
    workspace,
  });

  const entries = resourceTypes.map(
    (resourceType): [string, SourceResourceType] => [
      resourceType.name,
      {
        name: resourceType.name,
        schema: resourceType.schema as JSONSchema | undefined,
        description: resourceType.description,
        format_extension: resourceType.format_extension ?? null,
      },
    ],
  );

  // NOTE: normalize order at the provider boundary so both remote and local
  //       sources share a deterministic ordering contract
  entries.sort(([a], [b]) => compareStrings(a, b));

  // NOTE: a map rather than a plain object, as resource type names are
  //       arbitrary strings, and ones that collide with `Object.prototype`
  //       members (`constructor`, `toString`, ...) would otherwise be
  //       considered present when they aren't
  return new Map(entries);
};
