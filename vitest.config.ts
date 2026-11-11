import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "server/**/*.test.ts",
      "shared/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    exclude: ["tests/e2e/**"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
