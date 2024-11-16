import dedent from "dedent";
import { listScripts } from "../windmill/scripts.js";
import type { ResourceTypes } from "../windmill/resourceTypes.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";

const mapName = "scripts";

const preamble = dedent`  
  export const runScript = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
  ) => {
    const schema = ${mapName}[scriptPath];

    return wmill.runScript(scriptPath, null, schema.parse(args));
  };

  export const runScriptAsync = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
  ) => {
    const schema = ${mapName}[scriptPath];

    return wmill.runScriptAsync(scriptPath, null, schema.parse(args));
  };
`;

export const generateScripts = async () => {
  const { write } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listScripts(),
    mapName,
  });
};
