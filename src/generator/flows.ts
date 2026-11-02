import dedent from "dedent";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import { indent } from "./resources.js";
import { startJobBody } from "./runtime.js";
import type { Observer } from "./index.js";

const mapName = "flows";

const getPreamble = (runtimeCore: boolean) =>
  [
    dedent`
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
    `,
    indent(
      runtimeCore
        ? `return _startFlow(flowPath, ${mapName}[flowPath].parse(args), options);`
        : startJobBody({
            kind: "flow",
            segment: "f",
            pathVariable: "flowPath",
            detachedDefault: "true",
            body: `${mapName}[flowPath].parse(args)`,
          }),
    ),
    dedent`
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
    `,
  ].join("\n");

export const generateFlows = async (observer: Observer) => {
  const { write, config, source, runtimeImport } = getContext()!;

  await write(getPreamble(runtimeImport != null));

  return generateSchemas({
    generator: source.listFlows(),
    mapName,
    observer,
    looseArgs: config.flows.looseArgs,
  });
};
