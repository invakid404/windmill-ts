import PQueue from "p-queue";
import * as wmill from "windmill-client";

const PER_PAGE = 20;

export async function* listFlows(concurrency?: number) {
  const queue = new PQueue({ concurrency: concurrency ?? 5 });

  const workspace = process.env["WM_WORKSPACE"]!;

  for (let page = 1; ; ++page) {
    const pageData = await wmill.FlowService.listFlows({
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
          wmill.FlowService.getFlowByPath({
            workspace,
            path,
          }),
        { throwOnTimeout: true },
      ),
    );

    yield* promises;
  }
}
