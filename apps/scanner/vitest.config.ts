import { configDefaults, defineConfig } from "vitest/config";

// Exists for ONE reason: make `pnpm -F scanner run test` trustworthy so CI can
// invoke the package's own script instead of hand-scoping a path.
//
// e2e-appium/tests/*.spec.js are Appium/WebdriverIO specs run by Mocha (see
// e2e-appium/), not vitest. Vitest's default `include` matches `**/*.spec.js`,
// so without this exclude it collects all four and every one dies at import
// time with `ReferenceError: describe is not defined` — a guaranteed red run
// that has nothing to do with the code under test.
//
// configDefaults.exclude is spread rather than replaced: `test.exclude`
// OVERRIDES the defaults (it does not merge), and dropping them would let
// vitest walk node_modules/, dist/, android/ and ios/ build output.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e-appium/**"],
  },
});
