import { defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromPackages = (...segments: string[]) =>
  path.resolve(__dirname, "../../packages", ...segments);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
    testTimeout: 30000, // 30s for transcoding tests
  },
  resolve: {
    alias: [
      {
        find: "@th/adapters",
        replacement: resolveFromPackages("adapters", "src"),
      },
      { find: "@th/ports", replacement: resolveFromPackages("ports", "src") },
      { find: "@th/types", replacement: resolveFromPackages("types", "src") },
      { find: "@th/schema", replacement: resolveFromPackages("schema", "src") },
    ],
  },
});
