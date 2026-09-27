import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: the suites cover the server bundle and the pure
    // helpers in `aim/types.ts`. No DOM or React harness is needed — the
    // IM windows themselves are exercised by hand in bb-app, not here.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
