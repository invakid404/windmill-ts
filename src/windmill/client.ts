import * as wmill from "windmill-client";
import type { Workspace } from "./workspace.js";

export const setup = (workspace: Workspace) => {
  process.env["WM_WORKSPACE"] = workspace.workspaceId;
  wmill.setClient(workspace.token, new URL(workspace.remote).origin);
};
