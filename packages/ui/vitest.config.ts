import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const resolveFromRoot = (...segments: string[]) =>
  resolve(rootDir, ...segments);

export default defineConfig({
  test: {
    environment: "jsdom",
    // The gate entry queues for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    globalSetup: ["./test/global-setup.ts", fileURLToPath(new URL("../../scripts/dev/gate/vitest-global-setup.mjs", import.meta.url))],
    setupFiles: ["./test/setup.ts"],
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [
      ...configDefaults.exclude,
      "src/**/__visual__/**",
      "src/storybook/__e2e__/**",
      "src/ui/tamagui/components/__tests__/DateRangePicker.test.tsx",
      // This test suite expects the real `react-native` module, but this package aliases
      // `react-native` to a lightweight jsdom stub for all Vitest runs.
      "src/storybook/__tests__/react-native-mocks.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@th/schema": resolveFromRoot("../schema/src/index.ts"),

      // React Native-centric dependencies rely on Flow/JSX syntax that Rollup can't parse during Vitest runs.
      // Point them at lightweight web-friendly stubs so the UI stories can render in jsdom.
      "react-native": resolveFromRoot("./test/stubs/react-native.ts"),
      "react-native-reanimated": resolveFromRoot(
        "./test/stubs/react-native-reanimated.tsx",
      ),
      "@shopify/react-native-skia": resolveFromRoot(
        "./test/stubs/react-native-skia.tsx",
      ),
      "react-native-gesture-handler": resolveFromRoot(
        "./test/stubs/react-native-gesture-handler.tsx",
      ),
    },
  },
});
