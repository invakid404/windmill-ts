import type { JSONSchema } from "../generator/types.js";
import type {
  GenerationSource,
  ResourceTypes,
  SourceResource,
  SourceSchemaItem,
} from "./types.js";
import { compareStrings } from "./resources.js";
import { listResourceTypes } from "../windmill/resourceTypes.js";
import {
  getResourceValue,
  listResources as apiListResources,
} from "../windmill/resources.js";
import { listScripts as apiListScripts } from "../windmill/scripts.js";
import { listFlows as apiListFlows } from "../windmill/flows.js";

/**
 * Collect an async sequence of `{ path, schema? }` records and yield them in
 * ascending path order. The remote API pages and fetches details concurrently;
 * buffering the (already fetched) detail records lets us hand the generator a
 * deterministic order without changing the fetch/concurrency strategy.
 */
async function* orderedSchemaItems(
  items: AsyncIterable<{ path: string; schema?: unknown }>,
): AsyncGenerator<SourceSchemaItem> {
  const collected: SourceSchemaItem[] = [];
  for await (const { path, schema } of items) {
    collected.push({ path, schema: schema as JSONSchema | undefined });
  }
  collected.sort((a, b) => compareStrings(a.path, b.path));
  yield* collected;
}

/**
 * The default provider: reads generation metadata from a live Windmill
 * workspace via the existing HTTP-backed functions. Ordering is normalized at
 * this boundary so remote and local output share one deterministic contract.
 */
export const remoteSource: GenerationSource = {
  kind: "remote",

  listResourceTypes(): Promise<ResourceTypes> {
    return listResourceTypes();
  },

  async *listResources(): AsyncGenerator<SourceResource> {
    const collected: SourceResource[] = [];
    for await (const resource of apiListResources()) {
      collected.push(resource);
    }
    collected.sort((a, b) => compareStrings(a.path, b.path));
    yield* collected;
  },

  getResourceValue(path: string): Promise<unknown> {
    return getResourceValue(path);
  },

  listScripts(): AsyncGenerator<SourceSchemaItem> {
    return orderedSchemaItems(apiListScripts());
  },

  listFlows(): AsyncGenerator<SourceSchemaItem> {
    return orderedSchemaItems(apiListFlows());
  },
};
