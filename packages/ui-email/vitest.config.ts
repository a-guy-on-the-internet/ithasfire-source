import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolvePath = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

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
    globalSetup: [fileURLToPath(new URL("../../scripts/dev/gate/vitest-global-setup.mjs", import.meta.url))],
    environment: "node",
    coverage: {
      reporter: ["text", "html"],
      provider: "v8",
    },
  },
  resolve: {
    alias: {
      "@th/locale": resolvePath("../locale/src/index.ts"),
      "@th/locale/": resolvePath("../locale/src/"),
    },
  },
  plugins: [etaPlugin],
});
