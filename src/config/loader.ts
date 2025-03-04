import { parse } from "yaml";
import { readFile, access } from "fs/promises";
import { join, dirname } from "path";
import { ConfigSchema } from "./schema.js";

const CONFIG_FILE_NAMES = ["windmill-ts.yaml", "windmill-ts.yml"];

const fileExists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const findNearestConfig = async (startDir: string) => {
  let currentDir = startDir;

  while (true) {
    // Check for all possible files in parallel
    const configPaths = CONFIG_FILE_NAMES.map((name) => join(currentDir, name));
    const boundaryPaths = [
      join(currentDir, "package.json"),
      join(currentDir, ".git"),
    ];

    const [configExists, boundaryExists] = await Promise.all([
      Promise.all(configPaths.map(fileExists)),
      Promise.all(boundaryPaths.map(fileExists)),
    ]);

    // Check if multiple config files exist
    const existingConfigs = configPaths.filter(
      (_, index) => configExists[index],
    );
    if (existingConfigs.length > 1) {
      throw new Error(
        `Multiple configuration files found in ${currentDir}: ${existingConfigs.join(", ")}. Please use only one configuration file.`,
      );
    }

    // If we found exactly one config file, return its path
    if (existingConfigs.length === 1) {
      return existingConfigs[0];
    }

    // If we found a boundary marker, stop searching
    if (boundaryExists.some((exists) => exists)) {
      return null;
    }

    // Move up one directory
    const parentDir = dirname(currentDir);

    // If we're at the root directory and haven't found anything
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
};

export const loadConfig = async (cwd: string) => {
  try {
    const configPath = await findNearestConfig(cwd);

    if (!configPath) {
      return { ...ConfigSchema.parse({}), configPath: null };
    }

    const contents = await readFile(configPath, "utf-8");
    const parsed = parse(contents);

    return { ...ConfigSchema.parse(parsed), configPath } as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...ConfigSchema.parse({}), configPath: null };
    }

    throw error;
  }
};

export type Config = Awaited<ReturnType<typeof loadConfig>>;
