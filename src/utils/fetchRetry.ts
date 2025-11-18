import pRetry from "p-retry";

export interface FetchRetryConfig {
  /**
   * Number of retries to attempt
   * @default 3
   */
  retries?: number;
  /**
   * Minimum time to wait before retrying (in milliseconds)
   * @default 1000
   */
  minTimeout?: number;
  /**
   * Maximum time to wait before retrying (in milliseconds)
   * @default 10000
   */
  maxTimeout?: number;
  /**
   * Factor to multiply timeout by for each retry
   * @default 2
   */
  factor?: number;
  /**
   * Whether to enable retries
   * @default true
   */
  enabled?: boolean;
}

let isPatched = false;

/**
 * Monkeypatches the global fetch function to add retry logic.
 * This affects all fetch calls, including those made by windmill-client.
 */
export const patchFetchWithRetry = (config: FetchRetryConfig = {}) => {
  if (isPatched) {
    return;
  }

  const {
    enabled = true,
    retries = 3,
    minTimeout = 1000,
    maxTimeout = 10000,
    factor = 2,
  } = config;

  if (!enabled) {
    return;
  }

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    return pRetry(
      async () => {
        const response = await originalFetch(input, init);

        // Only retry on network errors or 5xx status codes
        // Don't retry on 4xx (client errors) as they're unlikely to succeed on retry
        if (!response.ok && response.status >= 500) {
          throw new Error(
            `Fetch failed with status ${response.status}: ${response.statusText}`,
          );
        }

        return response;
      },
      {
        retries,
        minTimeout,
        maxTimeout,
        factor,
      },
    );
  };

  isPatched = true;
};
