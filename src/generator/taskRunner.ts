import logUpdate from "log-update";
import cliSpinners from "cli-spinners";
import chalk from "chalk";

export interface Observer {
  next(message: string): void;
  error(err: unknown): void;
  complete(): void;
}

type TaskStatus = "running" | "done" | "failed";

type InternalTask<T> = {
  title: string;
  status: TaskStatus;
  message: string;
  error?: unknown;
  promise: Promise<T>;
};

export type TaskDefinition<T> = {
  title: string;
  task: (observer: Observer) => Promise<T>;
  enabled?: boolean;
};

export type RunTasksOptions = {
  silent?: boolean;
};

export const runTasks = async <T,>(
  definitions: TaskDefinition<T>[],
  options?: RunTasksOptions,
): Promise<T[]> => {
  const { silent = false } = options ?? {};

  const tasks: InternalTask<T>[] = definitions
    .filter((d) => d.enabled !== false)
    .map((def) => {
      const task: InternalTask<T> = {
        title: def.title,
        status: "running",
        message: "",
        promise: undefined!,
      };

      const observer: Observer = {
        next(message) {
          task.message = message;
        },
        error(err) {
          task.status = "failed";
          task.error = err;
        },
        complete() {
          if (task.status === "running") {
            task.status = "done";
          }
        },
      };

      task.promise = def.task(observer).then(
        (result) => {
          if (task.status === "running") task.status = "done";
          return result;
        },
        (err) => {
          task.status = "failed";
          task.error ??= err;
          throw err;
        },
      );

      return task;
    });

  if (silent) {
    return Promise.all(tasks.map((t) => t.promise));
  }

  const spinner = cliSpinners.dots;
  let frameIdx = 0;

  const render = () => {
    const frame = spinner.frames[frameIdx % spinner.frames.length];
    frameIdx++;

    const lines = tasks.map((task) => {
      const suffix = task.message ? chalk.dim(` [${task.message}]`) : "";

      switch (task.status) {
        case "running":
          return `${chalk.yellow(frame)} ${task.title}${suffix}`;
        case "done":
          return `${chalk.green("✔")} ${task.title}${suffix}`;
        case "failed":
          return `${chalk.red("✖")} ${task.title}${suffix}`;
      }
    });

    logUpdate(lines.join("\n"));
  };

  const interval = setInterval(render, spinner.interval);
  render();

  try {
    return await Promise.all(tasks.map((t) => t.promise));
  } finally {
    clearInterval(interval);
    render();
    logUpdate.done();
  }
};
