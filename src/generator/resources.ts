import toValidIdentifier from "to-valid-identifier";
import type { JSONSchema } from "./types.js";
import { getContext } from "./context.js";
import { schemaToZod } from "./common.js";
import dedent from "dedent";
import { compareStrings } from "../source/resources.js";
import type { Observer } from "./index.js";
import * as path from "node:path";
import capitalize from "@stdlib/string-capitalize";
import camelCase from "@stdlib/string-camelcase";

const resourceToTypeMap = "resourceToType";
const resourceTypesTypeName = "ResourceTypes";

const resourceTransformerName = "_resourcesTransformer";
const defaultResourceTransformerName = "_DefaultResourceTransformer";
const configuredResourceResolverName = "_configuredResourceResolver";

const defaultPerResourceTypeMap = "defaultPerResourceType";
const embeddedResourcesMapName = "_embeddedResources";
const resolveVariablesFnName = "_resolveVariables";

const defaultResourceTransformer = dedent`
  class ${defaultResourceTransformerName} implements Transformer {
    arg: unknown
    do(value: Cast<(typeof this)["arg"], object>) {
      return value;
    }
  }
`;

const resolveVariablesFnCode = dedent`
  async function ${resolveVariablesFnName}(obj: unknown): Promise<unknown> {
    if (typeof obj === "string" && obj.startsWith("$var:")) {
      return wmill.getVariable(obj.substring(5));
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map(${resolveVariablesFnName}));
    }
    if (obj != null && typeof obj === "object") {
      const entries = await Promise.all(
        Object.entries(obj).map(async ([k, v]) => [k, await ${resolveVariablesFnName}(v)] as const)
      );
      return Object.fromEntries(entries);
    }
    return obj;
  }
`;

type EmbedPreambleOptions = {
  enabled: boolean;
  resolveVariables: boolean;
  hasResourcesWithVars: boolean;
};

type ResourcePreambleOptions = {
  embed: EmbedPreambleOptions;
  hasConfiguredResourceResolver: boolean;
};

type ImportHookConfig = {
  importPath: string;
  importName: string;
  importExtension?: string;
} | null | undefined;

/** The import specifier of `file` from a module in `fromDir`. */
export const relativeImportPath = (fromDir: string, file: string) => {
  const importPath = path.relative(fromDir, file).replace(/\\/g, "/");

  return importPath.startsWith("./") || importPath.startsWith("../")
    ? importPath
    : `./${importPath}`;
};

const resolveConfiguredImport = (
  hook: ImportHookConfig,
  outputDir: string,
  configPath: string | null,
) => {
  if (!hook?.importPath || !hook.importName) {
    return null;
  }

  const configDir = configPath ? path.dirname(configPath) : process.cwd();

  let importPath = relativeImportPath(
    outputDir,
    path.resolve(configDir, hook.importPath),
  );

  if (hook.importExtension) {
    const extension = path.extname(importPath);
    if (extension) {
      importPath = importPath.slice(0, -extension.length);
    }
  }

  return {
    importPath: hook.importExtension
      ? `${importPath}${hook.importExtension}`
      : importPath,
    importName: hook.importName,
  };
};

const getEmbeddedResolverCode = (embed: EmbedPreambleOptions) => {
  if (!embed.enabled) {
    return dedent`
      const _hasEmbeddedResource = (_path: string) => false;

      const _resolveEmbeddedResource = async (
        _path: string,
      ): Promise<unknown | undefined> => undefined;
    `;
  }

  const valueExpression =
    embed.resolveVariables && embed.hasResourcesWithVars
      ? `entry.hasVars ? await ${resolveVariablesFnName}(entry.value) : structuredClone(entry.value)`
      : "structuredClone(entry.value)";

  return dedent`
    const _hasEmbeddedResource = (path: string) =>
      path in ${embeddedResourcesMapName};

    const _resolveEmbeddedResource = async (
      path: string,
    ): Promise<unknown | undefined> => {
      if (!_hasEmbeddedResource(path)) {
        return undefined;
      }

      const entry = ${embeddedResourcesMapName}[path as keyof typeof ${embeddedResourcesMapName}];
      return ${valueExpression};
    };
  `;
};

const hasVarReferences = (obj: unknown): boolean => {
  if (typeof obj === "string") return obj.startsWith("$var:");
  if (Array.isArray(obj)) return obj.some(hasVarReferences);
  if (obj != null && typeof obj === "object")
    return Object.values(obj).some(hasVarReferences);
  return false;
};

const transformerTypesCode = dedent`
  export type Cast<T, U> = T extends U ? T : U;

  export interface Transformer {
    arg: unknown;
    do(value: never): unknown;
  }

  export type ApplyTransformer<T extends { new (): Transformer }, Arg> = Awaited<
    ReturnType<(InstanceType<T> & { arg: Arg })["do"]>
  >;

  type GetResourceReturnType<Resource> = Promise<
    ApplyTransformer<typeof ${resourceTransformerName}, Resource>
  >;

  export type GetResourceOptions = {
    skipValidation?: boolean;
    skipTransformer?: boolean;
  };
`;

const resourcePathTypesCode = dedent`
  export type ResourcePath = keyof typeof ${resourceToTypeMap};
  export type ResourceTypeName = keyof ${resourceTypesTypeName} & string;
`;

const getResolverCode = ({
  embed,
  hasConfiguredResourceResolver,
}: ResourcePreambleOptions) => dedent`
  export type ResourceResolverContext = {
    path: string;
    resourceType: ResourceTypeName;
    options: Readonly<GetResourceOptions>;
    hasEmbeddedResource: boolean;
    resolveEmbedded: () => Promise<unknown | undefined>;
    fetchResource: () => Promise<unknown>;
    resolveDefault: () => Promise<unknown>;
  };

  export type ResourceResolverResult = { value: unknown } | undefined;

  export const resolvedResource = (value: unknown): ResourceResolverResult => ({
    value,
  });

  export type ResourceResolver = (
    context: ResourceResolverContext,
  ) => ResourceResolverResult | Promise<ResourceResolverResult>;

  let _runtimeResourceResolver: ResourceResolver | undefined;

  export const setResourceResolver = (
    resolver: ResourceResolver | undefined,
  ) => {
    _runtimeResourceResolver = resolver;
  };

  export const getResourceResolver = (): ResourceResolver | undefined =>
    _runtimeResourceResolver ?? ${hasConfiguredResourceResolver ? configuredResourceResolverName : "undefined"};

  ${getEmbeddedResolverCode(embed)}

  const _fetchResource = (path: string): Promise<unknown> =>
    wmill.getResource(path);

  const _resolveDefaultResource = async (path: string): Promise<unknown> => {
    const embeddedResource = await _resolveEmbeddedResource(path);
    if (embeddedResource !== undefined) {
      return embeddedResource;
    }

    return _fetchResource(path);
  };

  const _resolveResourceData = async ({
    path,
    resourceType,
    options,
  }: {
    path: string;
    resourceType: ResourceTypeName;
    options?: GetResourceOptions;
  }): Promise<unknown> => {
    const resolver = getResourceResolver();
    const resolverOptions = Object.freeze({ ...(options ?? {}) });

    const resolveDefault = () => _resolveDefaultResource(path);

    if (resolver == null) {
      return resolveDefault();
    }

    const resolved = await resolver({
      path,
      resourceType,
      options: resolverOptions,
      hasEmbeddedResource: _hasEmbeddedResource(path),
      resolveEmbedded: () => _resolveEmbeddedResource(path),
      fetchResource: () => _fetchResource(path),
      resolveDefault,
    });

    return resolved === undefined ? resolveDefault() : resolved.value;
  };
`;

// Validates, resolves and transforms the resource at \`path\`, given its
// \`{ name, schema }\` entry as \`resource\`
export const resolveResourceBody = dedent`
  const { name, schema } = resource;
  if (resourceType != null && name !== resourceType) {
    throw new Error(
      \`Unexpected resource type: expected \${JSON.stringify(resourceType)} but resource \${JSON.stringify(path)} has type \${JSON.stringify(name)}\`,
    );
  }

  const data = await _resolveResourceData({
    path,
    resourceType: name as ResourceTypeName,
    options,
  });
  const parsedData = (options?.skipValidation ? data : schema.parse(data)) as object;

  if (options?.skipTransformer) {
    return parsedData;
  }

  const transformer = ${resourceTransformerName}.prototype.do;

  return transformer.call({ arg: parsedData }, parsedData);
`;

export const indent = (code: string) =>
  code.replace(/^(?=.)/gm, "  ");

// With a separate runtime core, \`getResource\` hands the lookup to the core's
// \`_getResourceAs\`, which holds the resolution logic
const getResourceCode = (runtimeCore: boolean) => dedent`
  type GetResource = {
    <Path extends keyof typeof ${resourceToTypeMap}>(
      path: Path,
      options?: GetResourceOptions,
    ): GetResourceReturnType<z.infer<(typeof ${resourceToTypeMap})[Path]["schema"]>>;
    <Type extends keyof ${resourceTypesTypeName}>(
      path: string,
      resourceType: Type,
      options?: GetResourceOptions,
    ): GetResourceReturnType<${resourceTypesTypeName}[Type]>;
    (path: string, resourceType?: string, options?: GetResourceOptions): Promise<object>;
  };

  export const getResource: GetResource = async (
    path: string,
    resourceTypeOrOptions?: string | GetResourceOptions,
    maybeOptions?: GetResourceOptions,
  ): Promise<any> => {
    const resourceType = typeof resourceTypeOrOptions === "string" ? resourceTypeOrOptions : undefined;
    const options = typeof resourceTypeOrOptions === "object" ? resourceTypeOrOptions : maybeOptions;

    const resource = ${resourceToTypeMap}[path as ResourcePath];
    if (resource == null) {
      throw new Error(\`Unknown resource: \${JSON.stringify(path)}\`);
    }
` + "\n\n" + indent(
  runtimeCore
    ? "return _getResourceAs(path, resource, resourceType, options);"
    : resolveResourceBody,
) + "\n}";

const listResourcesCode = dedent`
  export const getDefaultResource = <
    T extends keyof typeof defaultPerResourceType,
  >(
    resourceType: T,
  ) => {
    const path = ${defaultPerResourceTypeMap}[resourceType];
    if (path == null) {
      throw new Error(\`No defaults found for resource type \${resourceType}\`);
    }

    return getResource(path);
  }

  export async function* listResourcesWithPaths<Type extends keyof ${resourceTypesTypeName}>(
    resourceType: Type,
    options?: { perPage?: number; skipValidation?: boolean },
  ) {
    const { perPage = 30, skipValidation = false } = options ?? {};
    const perPageSanitized = Math.max(Math.min(perPage, 100), 1);

    for (let page = 1; ; ++page) {
      const pageData = await wmill.ResourceService.listResource({
        workspace: process.env["WM_WORKSPACE"]!,
        page,
        perPage: perPageSanitized,
        resourceType,
      });

      if (pageData.length === 0) {
        break;
      }

      for (const { path } of pageData) {
        const resource = await getResource(path, resourceType, { skipValidation });
        yield { path, resource };
      }
    }
  }

  export async function* listResources<Type extends keyof ${resourceTypesTypeName}>(
    resourceType: Type,
    options?: { perPage?: number; skipValidation?: boolean },
  ) {
    for await (const { resource } of listResourcesWithPaths(resourceType, options)) {
      yield resource;
    }
  }
`;

const resourcePathHelpersCode = dedent`
  export const getResourcePathsForType = <Type extends keyof typeof pathsPerResourceType>(
    resourceType: Type,
  ): (typeof pathsPerResourceType)[Type] => {
    const paths = pathsPerResourceType[resourceType];
    if (paths == null) {
      throw new Error(\`Unknown resource type: \${JSON.stringify(resourceType)}\`);
    }
    return paths;
  }

  export const isResourcePathOfType = <Type extends keyof typeof pathsPerResourceType>(
    path: string,
    resourceType: Type,
  ): path is (typeof pathsPerResourceType)[Type][number] => {
    const paths = pathsPerResourceType[resourceType];
    if (paths == null) {
      return false;
    }
    return (paths as readonly string[]).includes(path);
  }
`;

const getRuntimeCode = (options: ResourcePreambleOptions) =>
  [transformerTypesCode, getResolverCode(options), resourcePathHelpersCode].join(
    "\n\n",
  );

// The resource part of a single-file client
const getPreamble = (options: ResourcePreambleOptions) =>
  [
    transformerTypesCode,
    resourcePathTypesCode,
    getResolverCode(options),
    getResourceCode(false),
    listResourcesCode,
    resourcePathHelpersCode,
  ].join("\n\n");

const writeHookImports = async () => {
  const { write, config, outputDir } = getContext()!;

  const transformerImport = resolveConfiguredImport(
    config.resources.transformer,
    outputDir,
    config.configPath,
  );

  if (transformerImport) {
    await write(
      `import { ${transformerImport.importName} as ${resourceTransformerName} } from ${JSON.stringify(transformerImport.importPath)};`,
    );
  } else {
    await write(defaultResourceTransformer);
    await write(
      `const ${resourceTransformerName} = ${defaultResourceTransformerName};`,
    );
  }

  const resolverImport = resolveConfiguredImport(
    config.resources.resolver,
    outputDir,
    config.configPath,
  );
  if (resolverImport) {
    await write(
      `import { ${resolverImport.importName} as ${configuredResourceResolverName} } from ${JSON.stringify(resolverImport.importPath)};`,
    );
  }

  return { hasConfiguredResourceResolver: resolverImport != null };
};

const fetchEmbeddedResources = async (observer: Observer) => {
  const { workspaceResources, config, source } = getContext()!;
  const { resourcesByType, pathToResourceType } = workspaceResources;

  const embeddedValues = new Map<string, unknown>();
  const embeddedPathsWithVars = new Set<string>();

  if (config.resources.embed.paths.length === 0) {
    return { embeddedValues, embeddedPathsWithVars };
  }

  observer.next("Fetching embedded resource values...");

  const allKnownPaths = new Set([...resourcesByType.values()].flat());

  for (const embedPath of config.resources.embed.paths) {
    if (!allKnownPaths.has(embedPath)) {
      const resourceType = pathToResourceType.get(embedPath);
      if (resourceType != null) {
        throw new Error(
          `Embedded resource ${JSON.stringify(embedPath)} has unsupported resource type ${JSON.stringify(resourceType)}`,
        );
      }
      throw new Error(
        `Embedded resource path ${JSON.stringify(embedPath)} not found in workspace`,
      );
    }
  }

  for (const embedPath of config.resources.embed.paths) {
    let value: unknown;
    try {
      value = await source.getResourceValue(embedPath);
    } catch (err) {
      throw new Error(
        `Failed to fetch embedded resource ${JSON.stringify(embedPath)}: ${err instanceof Error ? err.message : err}`,
      );
    }
    embeddedValues.set(embedPath, value);

    if (hasVarReferences(value)) {
      embeddedPathsWithVars.add(embedPath);
    }
  }

  return { embeddedValues, embeddedPathsWithVars };
};

type EmbeddedResources = Awaited<ReturnType<typeof fetchEmbeddedResources>>;

const embedOptions = ({ embeddedValues, embeddedPathsWithVars }: EmbeddedResources) => {
  const { config } = getContext()!;

  return {
    enabled: embeddedValues.size > 0,
    resolveVariables: config.resources.embed.resolveVariables,
    hasResourcesWithVars: embeddedPathsWithVars.size > 0,
  };
};

const writeEmbeddedResources = async ({
  embeddedValues,
  embeddedPathsWithVars,
}: EmbeddedResources) => {
  const { write, config } = getContext()!;

  if (embeddedValues.size === 0) {
    return;
  }

  if (config.resources.embed.resolveVariables && embeddedPathsWithVars.size > 0) {
    await write(resolveVariablesFnCode);
  }

  await write(`const ${embeddedResourcesMapName} = {`);
  for (const [resPath, value] of embeddedValues) {
    const hasVars = embeddedPathsWithVars.has(resPath);
    await write(`  ${JSON.stringify(resPath)}: { value: ${JSON.stringify(value)}, hasVars: ${hasVars} },`);
  }
  await write(`} as const;`);
};

const writePathsPerResourceType = async () => {
  const { write, workspaceResources } = getContext()!;

  await write(`const pathsPerResourceType = lazyObject(() => ({`);
  for (const [resourceTypeName, paths] of workspaceResources.resourcesByType) {
    await write(
      `${JSON.stringify(resourceTypeName)}: ${JSON.stringify(paths)} as const,`,
    );
  }
  await write(`} as const));`);
};

const writeResourceTypeSchema = async (resourceTypeName: string) => {
  const { write, resourceTypes, config } = getContext()!;
  const resourceType = resourceTypes.get(resourceTypeName)!;

  const resourceTypeSchema = schemaToZod(resourceType.schema as never, {
    resourceTypeToSchema: resourceTypeSchemaName,
    looseTopLevelObject: config.resources.looseSchemas,
  });

  await write(
    dedent`
      const ${resourceTypeSchemaName(resourceType.name)} = lazyObject(() => ({
        name: ${JSON.stringify(resourceType.name)},
        schema: ${resourceTypeSchema},
      }));
    `,
  );
};

const referencedResourceTypes = (schema: unknown): string[] => {
  if (schema == null || typeof schema !== "object") {
    return [];
  }

  const { format } = schema as { format?: unknown };
  const own =
    typeof format === "string" && format.startsWith("resource-")
      ? [format.slice("resource-".length)]
      : [];

  return [...own, ...Object.values(schema).flatMap(referencedResourceTypes)];
};

/**
 * The resource types whose schemas the runtime core declares: those of the
 * embedded resources, and the ones their schemas refer to.
 */
export const runtimeResourceTypes = () => {
  const { config, resourceTypes, workspaceResources } = getContext()!;

  const types = new Set<string>();
  const pending = config.resources.embed.paths.flatMap(
    (embedPath) => workspaceResources.pathToResourceType.get(embedPath) ?? [],
  );
  for (let type = pending.pop(); type != null; type = pending.pop()) {
    const resourceType = resourceTypes.get(type);
    if (resourceType == null || types.has(type)) {
      continue;
    }

    types.add(type);
    pending.push(...referencedResourceTypes(resourceType.schema));
  }

  return [...types].sort(compareStrings);
};

/**
 * Writes the resource part of the runtime core: the transformer, the resolver
 * hook, the embedded values, the resource paths per type and the schemas of
 * the runtime's resource types. A single-file client writes the same pieces
 * inline instead (see \`generateResources\`).
 */
export const writeResourceRuntime = async (observer: Observer) => {
  const { write } = getContext()!;

  const { hasConfiguredResourceResolver } = await writeHookImports();
  const embedded = await fetchEmbeddedResources(observer);
  const options = { embed: embedOptions(embedded), hasConfiguredResourceResolver };

  await write(`type ResourceTypeName = string;`);
  await write(getRuntimeCode(options));
  await writeEmbeddedResources(embedded);
  await writePathsPerResourceType();

  observer.next("Generating schemas...");
  for (const resourceTypeName of runtimeResourceTypes()) {
    await writeResourceTypeSchema(resourceTypeName);
  }

  return embedded;
};

export const generateResources = async (observer: Observer) => {
  const { write, workspaceResources, config, runtimeImport } = getContext()!;
  const { resourcesByType } = workspaceResources;

  // NOTE: with a runtime core, the shared runtime and the schemas of the
  //       resource types it needs live there, and this file imports them
  const runtimeTypes = new Set(runtimeImport == null ? [] : runtimeResourceTypes());

  if (runtimeImport == null) {
    const { hasConfiguredResourceResolver } = await writeHookImports();
    const embedded = await fetchEmbeddedResources(observer);
    await write(
      getPreamble({ embed: embedOptions(embedded), hasConfiguredResourceResolver }),
    );
    await writeEmbeddedResources(embedded);
    await writePathsPerResourceType();
  } else {
    await write(
      [resourcePathTypesCode, getResourceCode(true), listResourcesCode].join("\n\n"),
    );
  }

  observer.next("Generating schemas...");

  const defaultPerResourceType = new Map<string, string>();

  for (const [resourceTypeName, paths] of resourcesByType) {
    if (!runtimeTypes.has(resourceTypeName)) {
      await writeResourceTypeSchema(resourceTypeName);
    }

    const referencesSchemaName = resourceReferencesSchemaName(resourceTypeName);
    const referencesSchema = schemaToZod(
      makeReferencesSchema(resourceTypeName, paths),
    );

    await write(
      `const ${referencesSchemaName} = lazyObject(() => ${referencesSchema});`,
    );

    const defaultPath = getResourceTypeDefault(resourceTypeName, paths);
    if (defaultPath != null) {
      defaultPerResourceType.set(resourceTypeName, defaultPath);
    }
  }

  await write(`const ${resourceToTypeMap} = lazyObject(() => ({`);
  for (const [resourceTypeName, paths] of resourcesByType) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    for (const path of paths) {
      await write(`${JSON.stringify(path)}: ${typeSchemaName},`);
    }
  }
  await write(`} as const));`);

  await write(`export type ${resourceTypesTypeName} = {`);

  const resourceTypeNames = [...resourcesByType.keys()].toSorted();
  for (const resourceTypeName of resourceTypeNames) {
    const typeSchemaName = resourceTypeSchemaName(resourceTypeName);
    await write(
      `${JSON.stringify(resourceTypeName)}: z.infer<(typeof ${typeSchemaName})["schema"]>,`,
    );
  }
  await write("}");

  await write(`export const ${defaultPerResourceTypeMap} = {`);
  for (const [
    resourceTypeName,
    defaultPath,
  ] of defaultPerResourceType.entries()) {
    await write(
      `${JSON.stringify(resourceTypeName)}: ${JSON.stringify(defaultPath)},`,
    );
  }
  await write("} as const");

  if (config.resources.individualResourceTypeExports) {
    for (const resourceTypeName of resourceTypeNames) {
      const typeName = resourceTypeToTSTypeName(resourceTypeName);

      await write(
        `export type ${typeName} = ${resourceTypesTypeName}[${JSON.stringify(resourceTypeName)}];`,
      );
    }
  }

  observer.next("Done");
  observer.complete();
};

export const resourceReferencesSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_references`);

export const resourceTypeSchemaName = (resourceType: string) =>
  toValidIdentifier(`${resourceType}_type`);

export const getResourceTypeDefault = (resourceType: string, paths: string[]) => {
  const { config } = getContext()!;

  return resourceType in config.resources.defaults
    ? config.resources.defaults[resourceType]
    : paths.length === 1
      ? paths[0]
      : null;
};

const makeReferencesSchema = (resourceType: string, paths: string[]) => {
  const refs = paths.map((path) => `$res:${path}`);

  let defaultForType = getResourceTypeDefault(resourceType, refs);
  if (defaultForType != null && !defaultForType.startsWith("$res:")) {
    defaultForType = `$res:${defaultForType}`;
  }

  if (defaultForType != null && !refs.includes(defaultForType)) {
    throw new Error(
      `Default for resource type ${resourceType} is not valid: ${defaultForType} not found in resources`,
    );
  }

  return {
    type: "string",
    enum: refs,
    ...(defaultForType != null && { default: defaultForType }),
  } satisfies JSONSchema;
};

const resourceTypeToTSTypeName = (resourceTypeName: string) =>
  toValidIdentifier(capitalize(camelCase(resourceTypeName)));

export const __testing = {
  getEmbeddedResolverCode,
  getPreamble,
  resolveConfiguredImport,
};
