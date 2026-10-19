import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [fileURLToPath(new URL("../../scripts/dev/gate/vitest-global-setup.mjs", import.meta.url))],
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
