import PQueue from "p-queue";
import * as wmill from "windmill-client";

const PER_PAGE = 20;

export async function* listScripts(concurrency?: number) {
  const queue = new PQueue({ concurrency: concurrency ?? 5 });

  const workspace = process.env["WM_WORKSPACE"]!;

  for (let page = 1; ; ++page) {
    const pageData = await wmill.ScriptService.listScripts({
      workspace,
      page,
      perPage: PER_PAGE,
    });

    if (pageData.length === 0) {
      break;
    }

    const promises = pageData.map(({ path }) =>
      queue.add(
        () =>
          wmill.ScriptService.getScriptByPath({
            workspace,
            path,
          }),
        { throwOnTimeout: true },
      ),
    );

    yield* promises;
  }
}
