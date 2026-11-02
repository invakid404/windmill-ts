import dedent from "dedent";
import { getContext } from "./context.js";
import { writePreamble } from "./preamble.js";
import {
  getResourceTypeDefault,
  indent,
  resolveResourceBody,
  resourceTypeSchemaName,
  runtimeResourceTypes,
  writeResourceRuntime,
} from "./resources.js";
import type { Observer } from "./index.js";

export type JobStartOptions = {
  // What is started, as it reads in the error message
  kind: string;
  // The URL path segment for the job's kind (`p` or `f`)
  segment: string;
  pathVariable: string;
  detachedDefault: string;
  body: string;
};

/**
 * The body of a function starting a job: it returns the new job's id, and
 * throws when Windmill refuses to start it. Every fragment is code, spliced
 * into a template literal or an expression.
 */
export const startJobBody = ({
  kind,
  segment,
  pathVariable,
  detachedDefault,
  body,
}: JobStartOptions) => dedent`
  const { scheduledFor, detached = ${detachedDefault}, tag } = options ?? {};

  const scheduledInSeconds = Math.ceil(
    Math.max((scheduledFor?.getTime() ?? 0) - Date.now(), 0) / 1000,
  );

  const params: Record<string, string> = {};
  if (scheduledInSeconds) params["scheduled_in_secs"] = String(scheduledInSeconds);
  if (tag) params["tag"] = tag;
  if (!detached) {
    const parentJobId = process.env["WM_JOB_ID"];
    if (parentJobId) params["parent_job"] = parentJobId;
    const rootJobId = process.env["WM_ROOT_FLOW_JOB_ID"];
    if (rootJobId) params["root_job"] = rootJobId;
  }

  const url = new URL(\`\${wmill.OpenAPI.BASE}/w/\${process.env["WM_WORKSPACE"]}/jobs/run/${segment}/\${${pathVariable}}\`);
  url.search = new URLSearchParams(params).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": \`Bearer \${wmill.OpenAPI.TOKEN}\`,
    },
    body: JSON.stringify(${body}),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      \`Failed to start Windmill ${kind} \${String(${pathVariable})}: \${response.status} \${response.statusText} - \${responseText}\`,
    );
  }

  return responseText;
`;

const runtimeJobsCode = [
  dedent`
    export type RunAsyncOptions = {
      scheduledFor?: Date | null;
      detached?: boolean;
      /** Override the worker tag for this run */
      tag?: string;
    };

    // NOTE: We use raw fetch here because JobService.runScriptByPath/runFlowByPath don't
    // expose the root_job parameter, which is needed for proper job hierarchy tracking.
    const _startJob = async (
      kind: "script" | "flow",
      path: string,
      args: unknown,
      options: RunAsyncOptions | undefined,
    ) => {
  `,
  indent(
    startJobBody({
      kind: "${kind}",
      segment: '${kind === "flow" ? "f" : "p"}',
      pathVariable: "path",
      detachedDefault: 'kind === "flow"',
      body: "args",
    }),
  ),
  dedent`
    };

    /** \`runScriptAsync\` without the generated argument schema: \`args\` are sent as given. */
    export const runScriptAsync = (scriptPath: string, args: Record<string, unknown>, options?: RunAsyncOptions) =>
      _startJob("script", scriptPath, args, options);

    /** \`runFlowAsync\` without the generated argument schema: \`args\` are sent as given. */
    export const runFlowAsync = (flowPath: string, args: Record<string, unknown>, options?: RunAsyncOptions) =>
      _startJob("flow", flowPath, args, options);
  `,
].join("\n");

/**
 * Generates the runtime core (`resources.runtime`): what resolving the
 * embedded resources, listing resource paths and starting jobs need, without
 * the script, flow and resource registry. The client imports it, so modules
 * that use only this much can import the core and stay clear of the registry.
 */
export const generateRuntime = async (observer: Observer) => {
  const { write, workspaceResources } = getContext()!;

  await writePreamble();
  const { embeddedValues } = await writeResourceRuntime(observer);

  const embeddedTypes = [...embeddedValues.keys()].map((embedPath) => ({
    embedPath,
    type: workspaceResources.pathToResourceType.get(embedPath)!,
  }));

  await write(`const _embeddedResourceTypes = lazyObject(() => ({`);
  for (const { embedPath, type } of embeddedTypes) {
    await write(`${JSON.stringify(embedPath)}: ${resourceTypeSchemaName(type)},`);
  }
  await write(`}));`);

  await write(dedent`
    export type EmbeddedResourcePath = keyof typeof _embeddedResourceTypes;

    export const _getResourceAs = async (
      path: string,
      resource: { name: string; schema: z.ZodType },
      resourceType: string | undefined,
      options: GetResourceOptions | undefined,
    ): Promise<any> => {
  `);
  await write(indent(resolveResourceBody));
  await write(dedent`
    };

    /** \`getResource\` for the embedded resources only. */
    export const getResource = <Path extends EmbeddedResourcePath>(
      path: Path,
      options?: GetResourceOptions,
    ): GetResourceReturnType<z.infer<(typeof _embeddedResourceTypes)[Path]["schema"]>> =>
      _getResourceAs(path, _embeddedResourceTypes[path], undefined, options);
  `);

  await write(`const _embeddedDefaultPerResourceType = {`);
  for (const { embedPath, type } of embeddedTypes) {
    const paths = workspaceResources.resourcesByType.get(type) ?? [];
    if (getResourceTypeDefault(type, paths) === embedPath) {
      await write(`${JSON.stringify(type)}: ${JSON.stringify(embedPath)},`);
    }
  }
  await write(`} as const;`);

  await write(dedent`
    /** \`getDefaultResource\` for the resource types whose default resource is embedded. */
    export const getDefaultResource = <T extends keyof typeof _embeddedDefaultPerResourceType>(resourceType: T) =>
      getResource(_embeddedDefaultPerResourceType[resourceType]);
  `);

  await write(runtimeJobsCode);

  await write(
    `export { ${["lazyObject", ...runtimeResourceTypes().map(resourceTypeSchemaName)].join(", ")} };`,
  );
  await write(`export type { GetResourceReturnType };`);

  observer.next("Done");
  observer.complete();
};
