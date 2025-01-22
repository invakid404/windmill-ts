import dedent from "dedent";
import { listScripts } from "../windmill/scripts.js";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import type { Observer } from "./index.js";

const mapName = "scripts";

const preamble = dedent`  
  export const runScript = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
  ) => {
    const schema = ${mapName}[scriptPath];

    return wmill.runScript(scriptPath, null, schema.parse(args));
  };

  type RunScriptAsyncOptions = {
    detached?: boolean;
  };

  export const runScriptAsync = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path,
    args: z.input<(typeof ${mapName})[Path]>,
    options?: RunScriptAsyncOptions,
  ) => {
    const { detached = false } = options ?? {};
    const schema = ${mapName}[scriptPath];

    const runner = detached
      ? runDetached
      : <T extends unknown>(cb: () => Promise<T>) => cb();

    return runner(() => wmill.runScriptAsync(scriptPath, null, schema.parse(args)));
  };

  export const getScriptArgsSchema = <Path extends keyof typeof ${mapName}>(
    scriptPath: Path
  ) => {
    return ${mapName}[scriptPath];
  }
`;

export const generateScripts = async (observer: Observer) => {
  const { write } = getContext()!;

  await write(preamble);

  return generateSchemas({
    generator: listScripts(),
    mapName,
    observer,
  });
};
