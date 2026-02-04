import dedent from "dedent";
import { listScripts } from "../windmill/scripts.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import type { Observer } from "./index.js";

const mapName = "scripts";

const preamble = dedent`
  type RunScriptAsyncOptions = {
    scheduledFor?: Date | null;
    detached?: boolean;
    /** Override the worker tag for this run */
    tag?: string;
  };

  type RunScriptOptions = RunScriptAsyncOptions & {
    /** Log status messages while waiting for the job to complete */
    verbose?: boolean;
  };

  // NOTE: We use raw fetch here because JobService.runScriptByPath doesn't
  // expose the root_job parameter, which is needed for proper job hierarchy tracking.
  export const runScriptAsync = async <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunScriptAsyncOptions,
  ) => {
    const { scheduledFor, detached = false, tag } = options ?? {};
    const schema = ${mapName}[scriptPath];

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

    const url = new URL(\`\${wmill.OpenAPI.BASE}/w/\${process.env["WM_WORKSPACE"]}/jobs/run/p/\${scriptPath}\`);
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

  export const runScript = async <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunScriptOptions,
  ) => {
    const { verbose, ...asyncOptions } = options ?? {};
    const jobId = await runScriptAsync(scriptPath, args, asyncOptions);
    return wmill.waitJob(jobId, verbose);
  };

  export const getScriptArgsSchema = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path
  ) => {
    return ${mapName}[scriptPath];
  };

  export type ScriptPath = keyof typeof ${mapName};

  export type ScriptArgs<Path extends ScriptPath> = z.input<(typeof ${mapName})[Path]>;
`;

export const generateScripts = async (observer: Observer) => {
  const { write, config } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listScripts(),
    mapName,
    observer,
    looseArgs: config.scripts.looseArgs,
  });
};
