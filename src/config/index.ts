export * from "./schema.js";
export * from "./loader.js";

import { loadConfig } from "./loader.js";
import { once } from "../utils/once.js";

export const getConfig = once(() => loadConfig(process.cwd()));
