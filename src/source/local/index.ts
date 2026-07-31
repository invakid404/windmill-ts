import { realpath, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";
import type {
  GenerationSource,
  ResourceTypes,
  SourceResource,
  SourceResourceType,
  SourceSchemaItem,
} from "../types.js";
import { compareStrings, EXCLUDED_RESOURCE_TYPES } from "../resources.js";
import { discover, type DiscoveredFile } from "./discovery.js";
import {
  parseByFormat,
  parseFlowMetadata,
  parseResourceMetadata,
  parseResourceTypeMetadata,
  parseScriptMetadata,
} from "./parsing.js";
import {
  buildFilter,
  loadWmillConfig,
  type WmillConfig,
} from "./wmillConfig.js";
import { readResourceValue, type ResourceEntry } from "./resourceValues.js";
import {
  composeResourceTypes,
  type HubMode,
} from "./resourceTypes.js";

export type CreateLocalSourceOptions = {
  /** Path to the wmill sync root (resolved against cwd if relative). */
  folder: string;
  /** Honor wmill.yaml includes/excludes/skip* (default true). */
  respectWmillYaml?: boolean;
  /** Absolute path to an optional supplemental resource-type catalog. */
  resourceTypesFile?: string | null;
  /** Absolute cache-dir override, or null/undefined to auto-resolve. */
  cacheDir?: string | null;
  /** Hub mode; `--offline` maps to "offline". Default "online". */
  hubMode?: HubMode;
  /** Emit verbose diagnostics to stderr. */
  verbose?: boolean;
  /** Injectable fetch for tests; undefined uses the default implementation. */
  fetchImpl?: typeof fetch;
};

// A small shared bound on concurrent metadata file reads keeps very large trees
// (the reference tree has 1,039 scripts) from exhausting file descriptors or
// spiking memory. Results are collected and re-sorted, so the bound never
// affects deterministic output ordering.
const METADATA_READ_CONCURRENCY = 64;

type Limiter = <R>(task: () => Promise<R>) => Promise<R>;

const createLimiter = (limit: number): Limiter => {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = (): void => {
    while (active < limit && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <R>(task: () => Promise<R>): Promise<R> =>
    new Promise<R>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
};

const cloneSchema = <T>(schema: T): T =>
  schema == null ? schema : (structuredClone(schema) as T);

const cloneResourceType = (def: SourceResourceType): SourceResourceType => ({
  ...def,
  schema: cloneSchema(def.schema),
});

const cloneResourceTypes = (types: ResourceTypes): ResourceTypes =>
  new Map([...types].map(([name, def]) => [name, cloneResourceType(def)]));

/** Report every filename that maps to the same logical path/name. */
const assertNoDuplicates = (
  files: DiscoveredFile[],
  label: string,
  keyName: "path" | "name",
): void => {
  const byKey = new Map<string, DiscoveredFile[]>();
  for (const file of files) {
    const group = byKey.get(file.logical);
    if (group) {
      group.push(file);
    } else {
      byKey.set(file.logical, [file]);
    }
  }

  for (const [logical, group] of byKey) {
    if (group.length > 1) {
      const names = group.map((f) => f.relPath).sort(compareStrings);
      throw new Error(
        `Multiple ${label} files map to the same ${keyName} ${JSON.stringify(logical)}: ${names.join(", ")}`,
      );
    }
  }
};

/**
 * Reject branch-specific resource variants (D8: defer + reject ambiguity).
 *
 * Windmill names a branch override such as `f/x.main.resource.yaml` for base
 * `f/x.resource.yaml`; naively stripping `.resource.{yaml,json}` would emit a
 * bogus `f/x.main` resource path. We do not select a branch, so any resource
 * file whose logical path is branch-qualified — its trailing segment is a
 * declared git branch, or it lives under a `specificItems.resources` base — is a
 * hard error listing every relevant filename.
 */
const assertNoBranchSpecificResources = (
  resourceFiles: DiscoveredFile[],
  config: WmillConfig | null,
): void => {
  const branchNames = new Set(config?.gitBranchNames ?? []);
  const specificResourcePaths = config?.specificResourcePaths ?? [];
  if (branchNames.size === 0 && specificResourcePaths.length === 0) {
    return;
  }

  const byLogical = new Map(
    resourceFiles.map((file) => [file.logical, file] as const),
  );
  const relevant = new Set<string>();

  for (const file of resourceFiles) {
    const lastDot = file.logical.lastIndexOf(".");
    if (lastDot < 0) {
      continue;
    }
    const branchSuffix = file.logical.slice(lastDot + 1);
    const base = file.logical.slice(0, lastDot);
    const isBranchQualified =
      branchNames.has(branchSuffix) ||
      specificResourcePaths.some((path) => file.logical.startsWith(`${path}.`));
    if (!isBranchQualified) {
      continue;
    }
    relevant.add(file.relPath);
    const baseFile = byLogical.get(base);
    if (baseFile) {
      relevant.add(baseFile.relPath);
    }
  }

  if (relevant.size > 0) {
    const names = [...relevant].sort(compareStrings);
    throw new Error(
      `Branch-specific resource metadata is not supported (windmill-ts does not select a git branch): ${names.join(", ")}. ` +
        `Remove the branch-specific variants or generate from a single-branch checkout.`,
    );
  }
};

const parseSchemaItems = async (
  files: DiscoveredFile[],
  parse: (raw: unknown, relPath: string) => { schema?: SourceSchemaItem["schema"] },
  limit: Limiter,
): Promise<SourceSchemaItem[]> => {
  const items = await Promise.all(
    files.map((file): Promise<SourceSchemaItem> =>
      limit(async () => {
        const content = await readFile(file.absPath, "utf-8");
        const raw = parseByFormat(content, file.format, file.relPath);
        const { schema } = parse(raw, file.relPath);
        return { path: file.logical, schema };
      }),
    ),
  );
  items.sort((a, b) => compareStrings(a.path, b.path));
  return items;
};

async function* cloneSchemaItems(
  items: readonly SourceSchemaItem[],
): AsyncGenerator<SourceSchemaItem> {
  for (const item of items) {
    yield { path: item.path, schema: cloneSchema(item.schema) };
  }
}

/**
 * Build an immutable index of a wmill sync tree and expose it through the neutral
 * `GenerationSource` contract. The tree is crawled exactly once; each iterator
 * invocation yields fresh, deterministically ordered clones.
 */
export const createLocalSource = async (
  options: CreateLocalSourceOptions,
): Promise<GenerationSource> => {
  const root = nodePath.resolve(options.folder);

  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read source folder ${root}: ${reason}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Source folder ${root} is not a directory`);
  }
  const realRoot = await realpath(root);

  const respectWmillYaml = options.respectWmillYaml !== false;
  const wmillConfig = respectWmillYaml ? await loadWmillConfig(root) : null;
  const filter = buildFilter(wmillConfig);

  const discovered = await discover(root, realRoot);

  const scriptFiles: DiscoveredFile[] = [];
  const flowFiles: DiscoveredFile[] = [];
  const resourceFiles: DiscoveredFile[] = [];
  const resourceTypeFiles: DiscoveredFile[] = [];

  for (const file of discovered) {
    if (respectWmillYaml) {
      if (filter.isKindSkipped(file.kind)) {
        continue;
      }
      // Resource-type files bypass include/exclude path globs (mirroring the
      // wmill CLI); only skipResourceTypes gates them.
      if (file.kind !== "resourceType" && !filter.isPathIncluded(file.relPath)) {
        continue;
      }
    }

    switch (file.kind) {
      case "script":
        scriptFiles.push(file);
        break;
      case "flow":
        flowFiles.push(file);
        break;
      case "resource":
        resourceFiles.push(file);
        break;
      case "resourceType":
        resourceTypeFiles.push(file);
        break;
    }
  }

  assertNoBranchSpecificResources(resourceFiles, wmillConfig);

  assertNoDuplicates(scriptFiles, "script", "path");
  assertNoDuplicates(flowFiles, "flow", "path");
  assertNoDuplicates(resourceFiles, "resource", "path");
  assertNoDuplicates(resourceTypeFiles, "resource type", "name");

  // Shared bound across all metadata reads for this crawl.
  const readLimit = createLimiter(METADATA_READ_CONCURRENCY);

  const [scriptItems, flowItems] = await Promise.all([
    parseSchemaItems(scriptFiles, parseScriptMetadata, readLimit),
    parseSchemaItems(flowFiles, parseFlowMetadata, readLimit),
  ]);

  const resourceEntries: ResourceEntry[] = await Promise.all(
    resourceFiles.map((file): Promise<ResourceEntry> =>
      readLimit(async () => {
        const content = await readFile(file.absPath, "utf-8");
        const raw = parseByFormat(content, file.format, file.relPath);
        const { resource_type } = parseResourceMetadata(raw, file.relPath);
        return {
          path: file.logical,
          resource_type,
          absPath: file.absPath,
          relPath: file.relPath,
          format: file.format,
        };
      }),
    ),
  );
  resourceEntries.sort((a, b) => compareStrings(a.path, b.path));

  const localDefEntries = await Promise.all(
    resourceTypeFiles.map((file): Promise<SourceResourceType> =>
      readLimit(async () => {
        const content = await readFile(file.absPath, "utf-8");
        const raw = parseByFormat(content, file.format, file.relPath);
        return parseResourceTypeMetadata(raw, file.relPath, file.logical);
      }),
    ),
  );
  const localDefs = new Map<string, SourceResourceType>();
  for (const def of localDefEntries) {
    localDefs.set(def.name, def);
  }

  // Resource types actually used by emitted resources (post-exclusion).
  const usedNames = new Set<string>();
  for (const entry of resourceEntries) {
    if (!EXCLUDED_RESOURCE_TYPES.has(entry.resource_type)) {
      usedNames.add(entry.resource_type);
    }
  }

  const resourceTypes = await composeResourceTypes({
    localDefs,
    usedNames,
    resourceTypesFile: options.resourceTypesFile ?? null,
    cacheDir: options.cacheDir ?? null,
    hubMode: options.hubMode ?? "online",
    verbose: options.verbose ?? false,
    root: realRoot,
    fetchImpl: options.fetchImpl,
  });

  const resourceByPath = new Map(
    resourceEntries.map((entry) => [entry.path, entry] as const),
  );

  return {
    kind: "local",

    async listResourceTypes(): Promise<ResourceTypes> {
      return cloneResourceTypes(resourceTypes);
    },

    async *listResources(): AsyncGenerator<SourceResource> {
      for (const entry of resourceEntries) {
        yield { path: entry.path, resource_type: entry.resource_type };
      }
    },

    async getResourceValue(path: string): Promise<unknown> {
      const entry = resourceByPath.get(path);
      if (!entry) {
        throw new Error(`Unknown local resource: ${JSON.stringify(path)}`);
      }
      const def = resourceTypes.get(entry.resource_type);
      return readResourceValue(entry, realRoot, def?.format_extension);
    },

    listScripts(): AsyncGenerator<SourceSchemaItem> {
      return cloneSchemaItems(scriptItems);
    },

    listFlows(): AsyncGenerator<SourceSchemaItem> {
      return cloneSchemaItems(flowItems);
    },
  };
};
