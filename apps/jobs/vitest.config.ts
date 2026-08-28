import { defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromPackages = (...segments: string[]) =>
  path.resolve(__dirname, "..", "..", "packages", ...segments);

export default defineConfig({
  test: {
    globals: true,
  },
  // Mirrors packages/core, packages/adapters and apps/api. Without these,
  // workspace imports fall through to each package's `"./*": "./src/*"` exports
  // map, which resolves a DIRECTORY subpath (e.g. @th/core/use-cases/resale ->
  // src/use-cases/resale) and then stops — exports-map results get no
  // directory-index resolution, so collect fails with `Cannot find package`.
  // Aliasing to the source dir restores Vite's normal index resolution.
  //
  // NOT aliased: @th/ui-email (its src carries .eta templates Rollup can't parse
  // as JS — it ships a dist, which is what jobs resolves at runtime) and @th/db
  // (generated Prisma client, resolved via its package entry).
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
    ],
  },
});
