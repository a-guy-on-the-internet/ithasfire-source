import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const stub = (file: string) => resolve(rootDir, "test/stubs", file);

/**
 * ## Why this package renders in jsdom
 *
 * `@th/ui-native` had 25 pure palette tests and ZERO render tests — which is
 * how `ToneResultState` shipped a detail band and a "⌄ MORE" affordance on ten
 * of the eleven scan states while 260 tests stayed green. Every one of those
 * tests was a pure-function test of a module with no say in what renders.
 *
 * The native dependencies are aliased to lightweight web stubs, exactly as
 * `packages/ui/vitest.config.ts` already does: `react-native` ships Flow
 * source Vite cannot parse, `@th/ui` needs a Tamagui provider, and there is no
 * `react-test-renderer` in the workspace. The trade is explicit — these tests
 * prove STRUCTURE (which nodes exist, what they are labelled, what they do on
 * press) and prove nothing about layout, because Yoga is not running.
 */
export default defineConfig({
  test: {
    // Queue for a machine-wide light slot (scripts/dev/gate); watch mode takes none.
    // Absolute: a relative entry resolves against vitest's root (cwd), not this file.
    globalSetup: [fileURLToPath(new URL("../../scripts/dev/gate/vitest-global-setup.mjs", import.meta.url))],
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: [...configDefaults.exclude],
  },
  resolve: {
    alias: {
      "react-native": stub("react-native.tsx"),
      "lucide-react-native": stub("lucide-react-native.tsx"),
      "expo-secure-store": stub("expo-secure-store.ts"),
      "@th/ui": stub("th-ui.tsx"),
      /**
       * NOT a stub — the REAL `@th/types` module, resolved by path.
       *
       * The badge-tone drift guard has to compare this package's `BADGE_TONES`
       * against `@th/types`' `SCAN_STATUS_TONES`, and a guard that reads a copy
       * of the thing it guards guards a copy. Two ways to reach the real
       * source: add `@th/types` to this package's dependencies, or alias the
       * one leaf module the guard needs. The alias wins because `@th/types`'
       * barrel pulls `zod` and `luxon`, and a React-Native design-system
       * package acquiring that dependency edge — even in `devDependencies` —
       * is a worse trade than four lines of test config. The leaf module
       * itself imports nothing.
       *
       * `tsconfig.base.json` already maps `@th/types/*` → `packages/types/src/*`,
       * so editors and `pnpm typecheck` resolve the same specifier the same way.
       */
      "@th/types/scan/ticket-status-copy": resolve(
        rootDir,
        "../types/src/scan/ticket-status-copy.ts",
      ),
      /**
       * Same arrangement for the shared VERDICT map, which `verdict-tone-drift`
       * compares this package's `VerdictTone` against. It imports only
       * `./ticket-status-copy` (which imports nothing), so aliasing the leaf
       * pulls no barrel and no `zod`.
       */
      "@th/types/scan/verdict": resolve(
        rootDir,
        "../types/src/scan/verdict.ts",
      ),
    },
  },
});
