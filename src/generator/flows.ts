import dedent from "dedent";
import { listFlows } from "../windmill/flows.js";
import type { ResourceTypes } from "../windmill/resourceTypes.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";

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
    detached?: boolean;
  };

  export const runFlowAsync = <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunFlowAsyncOptions,
  ) => {
    const { detached = false } = options ?? {};
    const schema = ${mapName}[flowPath];

    const runner = detached
      ? runDetached
      : <T extends unknown>(cb: () => Promise<T>) => cb();

    return runner(() => wmill.runFlowAsync(flowPath, schema.parse(args)));
  };

  export const getFlowArgsSchema = <Path extends keyof typeof ${mapName}>(
    flowPath: Path
  ) => {
    return ${mapName}[flowPath];
  }
`;

export const generateFlows = async () => {
  const { write } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listFlows(),
    mapName,
  });
};
