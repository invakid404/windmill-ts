import * as wmill from "windmill-client";

export async function* listScripts() {
  const workspace = process.env["WM_WORKSPACE"]!;

  const scriptPaths = await wmill.ScriptService.listScriptPaths({
    workspace,
  });

  for (const path of scriptPaths) {
    const script = await wmill.ScriptService.getScriptByPath({
      workspace,
      path,
    });

    if (script.archived) {
      continue;
    }

    yield script;
  }
}
