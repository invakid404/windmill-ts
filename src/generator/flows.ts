import dedent from "dedent";
import { listFlows } from "../windmill/flows.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import type { Observer } from "./index.js";

const mapName = "flows";

const preamble = dedent`
  type RunFlowAsyncOptions = {
    scheduledFor?: Date | null;
    detached?: boolean;
    /** Override the worker tag for this run */
    tag?: string;
  };

  type RunFlowOptions = RunFlowAsyncOptions & {
    /** Log status messages while waiting for the job to complete */
    verbose?: boolean;
  };

  // NOTE: We use raw fetch here because JobService.runFlowByPath doesn't
  // expose the root_job parameter, which is needed for proper job hierarchy tracking.
  export const runFlowAsync = async <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunFlowAsyncOptions,
  ) => {
    const { scheduledFor, detached = true, tag } = options ?? {};
    const schema = ${mapName}[flowPath];

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

    const url = new URL(\`\${wmill.OpenAPI.BASE}/w/\${process.env["WM_WORKSPACE"]}/jobs/run/f/\${flowPath}\`);
    url.search = new URLSearchParams(params).toString();

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": \`Bearer \${wmill.OpenAPI.TOKEN}\`,
      },
      body: JSON.stringify(schema.parse(args)),
    });

    return response.text();
  };

  export const runFlow = async <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunFlowOptions,
  ) => {
    const { verbose, ...asyncOptions } = options ?? {};
    const jobId = await runFlowAsync(flowPath, args, asyncOptions);
    return wmill.waitJob(jobId, verbose);
  };

  export const getFlowArgsSchema = <Path extends keyof typeof ${mapName}>(
    flowPath: Path
  ) => {
    return ${mapName}[flowPath];
  }

  export type FlowPath = keyof typeof ${mapName};

  export type FlowArgs<Path extends FlowPath> = z.input<(typeof ${mapName})[Path]>;
`;

export const generateFlows = async (observer: Observer) => {
  const { write, config } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listFlows(),
    mapName,
    observer,
    looseArgs: config.flows.looseArgs,
  });
};
