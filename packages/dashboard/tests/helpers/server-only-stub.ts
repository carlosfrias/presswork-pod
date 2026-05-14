// Stand-in for the `server-only` package. The real one throws at import time
// when bundled into a client component to enforce a build-time boundary; in
// vitest we have no such boundary, so we replace it with a no-op module.
export {};
