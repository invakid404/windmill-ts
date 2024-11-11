// Lifted from https://github.com/windmill-labs/windmill/blob/main/cli/store.ts
// with the Deno cruft removed

import * as fs from "node:fs/promises";
import * as os from "node:os";

function ensureDir(dir: string) {
  return fs.mkdir(dir, { recursive: true });
}

function hash_string(str: string): number {
  let hash = 0,
    i,
    chr;
  if (str.length === 0) return hash;
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

export async function getRootStore(): Promise<string> {
  const store = (config_dir() ?? tmp_dir() ?? "/tmp/") + "/windmill/";
  await ensureDir(store);
  return store;
}

export async function getStore(baseUrl: string): Promise<string> {
  const baseHash = Math.abs(hash_string(baseUrl)).toString(16);
  const baseStore = (await getRootStore()) + baseHash + "/";
  await ensureDir(baseStore);
  return baseStore;
}

//inlined import dir from "https://deno.land/x/dir/mod.ts";
function tmp_dir(): string | null {
  switch (os.platform()) {
    case "linux": {
      const xdg = process.env["XDG_RUNTIME_DIR"];
      if (xdg) return `${xdg}-/tmp`;

      const tmpDir = process.env["TMPDIR"];
      if (tmpDir) return tmpDir;

      const tempDir = process.env["TEMP"];
      if (tempDir) return tempDir;

      const tmp = process.env["TMP"];
      if (tmp) return tmp;

      return "/var/tmp";
    }
    case "darwin":
      return process.env["TMPDIR"] ?? null;
    case "win32":
      return process.env["TMP"] ?? process.env["TEMP"] ?? null;
  }
  return null;
}

function config_dir(): string | null {
  switch (os.platform()) {
    case "linux": {
      const xdg = process.env["XDG_CONFIG_HOME"];
      if (xdg) return xdg;

      const home = process.env["HOME"];
      if (home) return `${home}/.config`;
      break;
    }

    case "darwin": {
      const home = process.env["HOME"];
      if (home) return `${home}/Library/Preferences`;
      break;
    }

    case "win32":
      return process.env["APPDATA"] ?? null;
  }

  return null;
}
