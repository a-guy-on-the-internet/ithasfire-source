import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromPackages = (...segments: string[]) =>
  path.resolve(__dirname, "..", ...segments);

export default defineConfig({
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [path.resolve(__dirname, "../../scripts/dev/gate/vitest-global-setup.mjs")],
    environment: "node",
    // Production roots configure the location obfuscation key at boot; so do tests.
    setupFiles: ["./test/setup/location-obfuscation-key.ts"],
    // Vitest's globbing will happily walk pnpm's virtual store, which explodes the number of Dirent objects
    // and eventually OOMs. Explicitly exclude `.pnpm` in addition to the stock patterns.
    exclude: [...configDefaults.exclude, "test/**", "**/.pnpm/**"],
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 1,
        isolate: true,
      },
    },
    deps: {
      optimizer: {
        web: {
          enabled: false,
        },
        ssr: {
          enabled: false,
        },
      },
    },
  },
  ssr: {
    external: ["zod"],
  },
  resolve: {
    alias: [
      { find: "@th/core", replacement: path.resolve(__dirname, "src") },
      {
        find: "@th/adapters",
        replacement: resolveFromPackages("adapters", "src"),
      },
      { find: "@th/schema", replacement: resolveFromPackages("schema", "src") },
      {
        find: "@th/test-utils",
        replacement: resolveFromPackages("test-utils", "src"),
      },
    ],
  },
});
