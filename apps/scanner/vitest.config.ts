import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

// Exists for TWO reasons.
//
// 1. Make `pnpm -F scanner run test` trustworthy so CI can invoke the
//    package's own script instead of hand-scoping a path.
//
//    e2e-appium/tests/*.spec.js are Appium/WebdriverIO specs run by Mocha (see
//    e2e-appium/), not vitest. Vitest's default `include` matches
//    `**/*.spec.js`, so without this exclude it collects all four and every one
//    dies at import time with `ReferenceError: describe is not defined` — a
//    guaranteed red run that has nothing to do with the code under test.
//
//    configDefaults.exclude is spread rather than replaced: `test.exclude`
//    OVERRIDES the defaults (it does not merge), and dropping them would let
//    vitest walk node_modules/, dist/, android/ and ios/ build output.
//
// 2. Run SCREEN tests (`src/screens/__tests__/**/*.test.tsx`) in jsdom against
//    the harness in `test/harness/`, while every other test keeps running in
//    node exactly as before. Two projects rather than a per-file
//    `@vitest-environment` docblock, because the screen project also needs the
//    native-module ALIASES below, and those must never leak into the pure node
//    tests (an alias changes what `react-native` resolves to for every file in
//    the project).

const rootDir = dirname(fileURLToPath(import.meta.url));
const stub = (file: string) => resolve(rootDir, "test/stubs", file);
/**
 * Stubs SHARED with `@th/ui-native`'s render tests, used as-is. Only the ones
 * the scanner needs nothing extra from; `react-native` and
 * `lucide-react-native` are extended locally (see `test/stubs/`).
 */
const uiNativeStub = (file: string) =>
  resolve(rootDir, "../../packages/ui-native/test/stubs", file);

const SCREEN_TESTS = "src/screens/__tests__/**/*.test.tsx";
const EXCLUDE = [...configDefaults.exclude, "e2e-appium/**"];
// Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
// Set per project: a root-level globalSetup does not reach inline projects.
// Both projects share one slot per vitest process.
const GATE_SETUP = resolve(rootDir, "../../scripts/dev/gate/vitest-global-setup.mjs");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          globalSetup: [GATE_SETUP],
          environment: "node",
          exclude: [...EXCLUDE, SCREEN_TESTS],
        },
      },
      {
        test: {
          name: "screen",
          globalSetup: [GATE_SETUP],
          environment: "jsdom",
          include: [SCREEN_TESTS],
          exclude: EXCLUDE,
          setupFiles: [resolve(rootDir, "test/harness/setup.ts")],
        },
        // `expo/tsconfig.base` sets `jsx: "react-native"` (Metro/Babel does the
        // transform on device), which esbuild reads as the CLASSIC runtime and
        // compiles to `React.createElement` with no `React` in scope.
        esbuild: { jsx: "automatic" },
        resolve: {
          alias: {
            "react-native": stub("react-native.tsx"),
            "react-native-safe-area-context": stub("safe-area-context.tsx"),
            "lucide-react-native": stub("lucide-react-native.tsx"),
            "expo-camera": stub("expo-camera.tsx"),
            "@sentry/react-native": stub("sentry.ts"),
            tamagui: stub("tamagui.tsx"),
            "@th/ui": uiNativeStub("th-ui.tsx"),
            "expo-secure-store": uiNativeStub("expo-secure-store.ts"),
          },
        },
      },
    ],
  },
});
