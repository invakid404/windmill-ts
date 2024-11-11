import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getRootStore } from "./store.js";

export const WorkspaceSchema = z.object({
  remote: z.string().url(),
  workspaceId: z.string(),
  name: z.string(),
  token: z.string(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

export const getAllWorkspaces = async () => {
  const rootStore = await getRootStore();
  const workspacesPath = path.join(rootStore, "remotes.ndjson");

  const content = await fs.readFile(workspacesPath, "utf-8");

  const workspaces = content
    .split("\n")
    .map((line) => {
      if (line.length <= 2) {
        return;
      }

      return WorkspaceSchema.parse(JSON.parse(line));
    })
    .filter((value) => value != null);

  return workspaces.reduce(
    (acc, workspace) => ({
      ...acc,
      [workspace.name]: workspace,
    }),
    {} as Partial<Record<string, Omit<Workspace, "name">>>,
  );
};

export const getActiveWorkspace = async () => {
  const workspaces = await getAllWorkspaces();

  const rootStore = await getRootStore();

  const activeWorkspacePath = path.join(rootStore, "activeWorkspace");
  const activeWorkspaceName = await fs.readFile(activeWorkspacePath, "utf-8");

  const activeWorkspace = workspaces[activeWorkspaceName];
  if (activeWorkspace == null) {
    return null;
  }

  return {
    ...activeWorkspace,
    name: activeWorkspaceName,
  };
};
