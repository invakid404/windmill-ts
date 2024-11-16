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

  export const runFlowAsync = <Path extends keyof typeof ${mapName}>(
    flowPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
  ) => {
    const schema = ${mapName}[flowPath];

    return wmill.runFlowAsync(flowPath, schema.parse(args));
  };
`;

export const generateFlows = async () => {
  const { write } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listFlows(),
    mapName,
  });
};
