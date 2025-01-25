import dedent from "dedent";
import { listFlows } from "../windmill/flows.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import type { Observer } from "./index.js";

const mapName = "flows";

const preamble = dedent`  
  export const runFlow = <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
  ) => {
    const schema = ${mapName}[flowPath];

    return wmill.runFlow(flowPath, schema.parse(args));
  };

  type RunFlowAsyncOptions = {
    scheduledFor?: Date | null;
    detached?: boolean;
  };

  export const runFlowAsync = <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunFlowAsyncOptions,
  ) => {
    const { scheduledFor, detached = false } = options ?? {};
    const schema = ${mapName}[flowPath];

    const runner = detached
      ? runDetached
      : <T extends unknown>(cb: () => Promise<T>) => cb();

    const scheduledInSeconds = Math.ceil(
      Math.max((scheduledFor?.getTime() ?? 0) - Date.now(), 0) / 1000,
    );

    return runner(
      () => wmill.runFlowAsync(flowPath, schema.parse(args), scheduledInSeconds)
    );
  };

  export const getFlowArgsSchema = <Path extends keyof typeof ${mapName}>(
    flowPath: Path
  ) => {
    return ${mapName}[flowPath];
  }

  export type FlowPath = keyof typeof ${mapName};
`;

export const generateFlows = async (observer: Observer) => {
  const { write } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listFlows(),
    mapName,
    observer,
  });
};
