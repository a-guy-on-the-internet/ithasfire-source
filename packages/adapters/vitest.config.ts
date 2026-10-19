import { configDefaults, defineConfig } from "vitest/config";
import path from "node:path";

const resolveFromPackages = (...segments: string[]) =>
  path.resolve(__dirname, "..", ...segments);

const etaPlugin = {
  name: "eta-text-loader",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (id.endsWith(".eta")) {
      return {
        code: `export default ${JSON.stringify(code)};`,
        map: null,
      };
    }
    return undefined;
  },
};

export default defineConfig({
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [path.resolve(__dirname, "../../scripts/dev/gate/vitest-global-setup.mjs")],
    environment: "node",
    // Production roots configure the location obfuscation key at boot; so do tests.
    setupFiles: ["./test/setup/location-obfuscation-key.ts"],
    exclude: [...configDefaults.exclude, "**/.pnpm/**"],
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
        web: { enabled: false },
        ssr: { enabled: false },
      },
    },
  },
  ssr: {
    external: ["zod"],
  },
  plugins: [etaPlugin],
  resolve: {
    alias: [
      { find: "@th/core", replacement: resolveFromPackages("core", "src") },
      { find: "@th/ports", replacement: resolveFromPackages("ports", "src") },
      { find: "@th/types", replacement: resolveFromPackages("types", "src") },
      {
        find: "@th/test-utils",
        replacement: resolveFromPackages("test-utils", "src"),
      },
      {
        find: "@th/ui-email",
        replacement: resolveFromPackages("ui-email", "src"),
      },
    ],
  },
});
