import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromRoot = (...segments: string[]) =>
  path.resolve(__dirname, "..", "..", ...segments);

export default defineConfig({
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [path.resolve(__dirname, "../../../scripts/dev/gate/vitest-global-setup.mjs")],
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    // Keep Vitest from crawling pnpm's virtual store to avoid Dirent explosions and OOMs.
    exclude: [...configDefaults.exclude, "**/.pnpm/**"],
  },
  resolve: {
    alias: {
      "@th/core": resolveFromRoot("core", "src"),
      "@th/adapters": resolveFromRoot("adapters", "src"),
      "@th/schema": resolveFromRoot("schema", "src"),
      "@th/types": resolveFromRoot("types", "src"),
      "@th/ports": resolveFromRoot("ports", "src"),
      "@th/test-utils": resolveFromRoot("test-utils", "src"),
      "@th/trpc": path.resolve(__dirname, "src"),
    },
  },
});
