import { defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromPackages = (...segments: string[]) =>
  path.resolve(__dirname, "..", "..", "packages", ...segments);

// This config exists so API tests can run in this workspace without Vite trying
// to infer/parse tsconfig files from other packages (which may use workspace
// tsconfig presets that aren't resolvable in Vitest's runtime).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
  // Mirrors packages/core and packages/adapters. Without these, workspace
  // imports fall through to each package's `"./*": "./src/*"` exports map,
  // which resolves a DIRECTORY subpath (e.g. @th/adapters/content-filter ->
  // src/content-filter) and then stops — exports-map results get no
  // directory-index resolution, so `Cannot find package` at collect time.
  // Aliasing to the source dir lets Vite do its normal index resolution, the
  // same way it already works for packages/*. 60+ such directory-style imports
  // exist repo-wide and resolve fine under tsx/Next at runtime; this gap was
  // only ever in these two app-level vitest configs.
  resolve: {
    alias: [
      { find: "@th/core", replacement: resolveFromPackages("core", "src") },
      {
        find: "@th/adapters",
        replacement: resolveFromPackages("adapters", "src"),
      },
      { find: "@th/ports", replacement: resolveFromPackages("ports", "src") },
      { find: "@th/types", replacement: resolveFromPackages("types", "src") },
      { find: "@th/errors", replacement: resolveFromPackages("errors", "src") },
      {
        find: "@th/test-utils",
        replacement: resolveFromPackages("test-utils", "src"),
      },
      // Deliberately NOT aliased: @th/ui-email. Its source tree contains .eta
      // templates that Rollup can't parse as JS (packages/adapters carries a
      // dedicated eta-text-loader plugin for exactly this). It ships a built
      // dist, which is what the API resolves at runtime anyway — so let the
      // package entry handle it rather than reaching into src.
    ],
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
    },
  },
});
