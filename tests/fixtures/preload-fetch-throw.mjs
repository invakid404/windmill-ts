// Preloaded via `node --import` to prove the CLI performs no network access:
// any fetch attempt throws instead of touching the network.
globalThis.fetch = async () => {
  throw new Error("network access is disabled in this test");
};
