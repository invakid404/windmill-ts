import dedent from "dedent";
import { getContext } from "./context.js";
import { generateSchemas } from "./common.js";
import { indent } from "./resources.js";
import { startJobBody } from "./runtime.js";
import type { Observer } from "./index.js";

const mapName = "scripts";

const getPreamble = (runtimeCore: boolean) =>
  [
    dedent`
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
    `,
    indent(
      runtimeCore
        ? `return _startScript(scriptPath, ${mapName}[scriptPath].parse(args), options);`
        : startJobBody({
            kind: "script",
            segment: "p",
            pathVariable: "scriptPath",
            detachedDefault: "false",
            body: `${mapName}[scriptPath].parse(args)`,
          }),
    ),
    dedent`
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
    `,
  ].join("\n");

export const generateScripts = async (observer: Observer) => {
  const { write, config, source, runtimeImport } = getContext()!;

  await write(getPreamble(runtimeImport != null));

  return generateSchemas({
    generator: source.listScripts(),
    mapName,
    observer,
    looseArgs: config.scripts.looseArgs,
  });
};
