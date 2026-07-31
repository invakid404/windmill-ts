import { z } from "zod";
import type { JSONSchema } from "../../generator/types.js";
import { compareStrings } from "../resources.js";

/** The fixed, unauthenticated public schema-bearing endpoint (v1). */
export const HUB_ENDPOINT = "https://hub.windmill.dev/resource_types/list";

/**
 * A Hub failure that must NOT be retried: an HTTP status error or a
 * normalized-response-shape failure. Retry fatality is decided by this marker
 * (via `instanceof`), not by matching error-message wording, so rewording a
 * message can never silently change retry behavior. External `message` text is
 * unchanged.
 */
export class HubFatalError extends Error {
  override readonly name = "HubFatalError";
  readonly fatal = true as const;
}

export type HubResourceType = {
  name: string;
  schema: JSONSchema;
  description?: string | null;
  app?: string | null;
};

export type HubNormalizeResult = {
  types: HubResourceType[];
  /** Names dropped because their schema was missing or unparseable. */
  omitted: string[];
};

// The server's Rust shape: id:i64, name:String, schema:Option<String>,
// description:Option<String>, app:String. Extra fields are tolerated.
const HubRecordSchema = z
  .object({
    id: z.number().optional(),
    name: z.string().min(1),
    schema: z.union([z.string(), z.null()]).optional(),
    description: z.union([z.string(), z.null()]).optional(),
    app: z.union([z.string(), z.null()]).optional(),
  })
  .loose();

const HubResponseSchema = z.array(HubRecordSchema);

/**
 * Validate and normalize a raw Hub list response into parsed, name-sorted
 * records. Schemas arrive as JSON-encoded strings; records with a missing or
 * unparseable schema are omitted (their names collected for diagnostics), and
 * duplicate names among the valid records are rejected.
 */
export const normalizeHubResponse = (json: unknown): HubNormalizeResult => {
  const parsed = HubResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new HubFatalError(
      `Unexpected Hub response shape: ${parsed.error.issues[0]?.message ?? "not a resource-type list"}`,
    );
  }

  // Reject duplicate names on the RAW records, before schema validity is even
  // considered: a catalog that names the same type twice is untrustworthy
  // regardless of which copy happens to carry a usable schema.
  const seen = new Set<string>();
  for (const record of parsed.data) {
    if (seen.has(record.name)) {
      throw new HubFatalError(
        `Hub response contains duplicate resource type name ${JSON.stringify(record.name)}`,
      );
    }
    seen.add(record.name);
  }

  const types: HubResourceType[] = [];
  const omitted: string[] = [];

  for (const record of parsed.data) {
    if (typeof record.schema !== "string") {
      omitted.push(record.name);
      continue;
    }
    let schema: unknown;
    try {
      schema = JSON.parse(record.schema);
    } catch {
      omitted.push(record.name);
      continue;
    }
    if (schema == null || typeof schema !== "object" || Array.isArray(schema)) {
      omitted.push(record.name);
      continue;
    }
    types.push({
      name: record.name,
      schema: schema as JSONSchema,
      description: record.description ?? undefined,
      app: record.app ?? undefined,
    });
  }

  types.sort((a, b) => compareStrings(a.name, b.name));
  omitted.sort(compareStrings);

  return { types, omitted };
};

export type FetchHubOptions = {
  fetchImpl?: typeof fetch;
  retries?: number;
  timeoutMs?: number;
  /** Base backoff in ms; overridable for tests. */
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
};

const RETRYABLE_STATUS = new Set([408, 429]);

const isRetryableStatus = (status: number): boolean =>
  RETRYABLE_STATUS.has(status) || status >= 500;

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Perform one logical full-list fetch of the public Hub catalog, with bounded
 * transient retries. Sends no credentials, workspace metadata, or identifiers —
 * only a plain `Accept: application/json` GET and a non-identifying user agent.
 */
export const fetchHubResourceTypes = async (
  options: FetchHubOptions = {},
): Promise<HubNormalizeResult> => {
  const {
    fetchImpl = fetch,
    retries = 3,
    timeoutMs = 15000,
    minTimeoutMs = 500,
    maxTimeoutMs = 8000,
  } = options;

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(HUB_ENDPOINT, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "windmill-ts",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < retries) {
          const retryAfter = parseRetryAfter(
            response.headers.get("retry-after"),
          );
          const cappedExponential = Math.min(
            maxTimeoutMs,
            minTimeoutMs * 2 ** attempt,
          );
          // Honor a server-supplied Retry-After, but never let it exceed the
          // configured maximum — a large seconds value or far-future date must
          // not suspend generation for hours.
          const backoff =
            retryAfter != null
              ? Math.min(retryAfter, maxTimeoutMs)
              : cappedExponential;
          attempt++;
          await sleep(backoff);
          continue;
        }
        throw new HubFatalError(
          `Hub request failed: HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }

      const json = await response.json();
      return normalizeHubResponse(json);
    } catch (err) {
      lastError = err;
      // Fatality is structural (a HubFatalError marker), not message-based, so
      // HTTP-status and response-shape failures are never retried. Everything
      // else (network errors, timeouts/aborts, malformed JSON) is transient.
      if (err instanceof HubFatalError || attempt >= retries) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      const backoff = Math.min(maxTimeoutMs, minTimeoutMs * 2 ** attempt);
      attempt++;
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Hub request failed"));
};
