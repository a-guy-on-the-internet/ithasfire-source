import { parser as tsParser } from "typescript-eslint";

import { colorPermanents } from "./eslint-color-permanents.mjs";

/**
 * `scanner` lint — DESIGN-SYSTEM COLOR RULE ONLY.
 *
 * This config is deliberately narrow, and mirrors `packages/ui/eslint.config.mjs`. It does NOT
 * adopt the TS/react rulesets that `apps/web` runs, nor the `expo lint` (eslint-config-expo)
 * preset that the sibling `apps/mobile` uses: this app was previously unlinted *entirely* — it
 * had no `lint` script at all, so `turbo run lint` skipped it — and turning on a full ruleset
 * would surface a mountain of unrelated pre-existing findings and red-CI the whole `pnpm lint`
 * run. The single job here is to keep raw color literals out of the scanner's screens. Widening
 * this to a real ruleset is a worthwhile follow-up, but it is its own change with its own
 * cleanup budget — not a rider on a color gate.
 *
 * ## Why the rule is hex-only (and not the web's token rule)
 *
 * React Native cannot use CSS variables, so `@th/ui`'s web pattern — `var(--accent, #E2481D)` —
 * is meaningless here. There is no runtime cascade to resolve it. The scanner's rule is
 * therefore simpler and stricter: colors come from the shared palette module in `@th/ui-native`, which
 * is the RN analogue of `packages/ui/src/ui/tamagui/tokens/`. Raw hex belongs THERE and nowhere
 * else; components import from it. (`packages/ui` also bans raw `rgba(255,255,255,…)`; that rule
 * is intentionally NOT ported — on the web it flags Ember-era white that is invisible on the
 * shipped Stub cream, whereas the scanner's Ember theme is dark and its FIXED camera-overlay values are
 * deliberately light-on-black. It would fire on correct values in palette.ts alone.)
 *
 * `eslint` / `typescript-eslint` resolve from the workspace root rather than being declared as
 * devDeps of this package. That is deliberate and safe here: `.npmrc` pins `nodeLinker=hoisted`
 * + `shamefullyHoist=true`, so root devDeps are resolvable from every package. Declaring them
 * locally would force a lockfile re-resolve that floats unrelated deps — churn this change has
 * no business making. If the repo ever moves off hoisted linking, add `eslint` +
 * `typescript-eslint` to apps/scanner devDependencies in a dedicated dependency change.
 *
 * See docs/design/design-system-v2.md.
 */

/** Files the design-system color rule never applies to. */
const DS_RULE_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  // NOTE: there is deliberately no palette exemption here any more. The palette
  // moved to `@th/ui-native` (`packages/ui-native/src/palette.ts`), which carries
  // its own copy of this gate exempting itself. That means this app now has NO
  // sanctioned home for a raw hex at all — every literal must either be a named
  // token in the package or an entry in eslint-color-permanents.mjs with a
  // written reason. Do not re-add an app-local palette path: a file that does
  // not exist silently widens nothing today, but would license a new local
  // palette to reappear and re-diverge from the shared one.
];

/**
 * Design System v2 — "no raw hex in components", RN flavour.
 *
 * Bans a BARE hex color literal (`"#FF5721"`, `'#fff'`, `"#000"`). Anchored to the whole string
 * value, so it targets a literal that *is* a color — not prose, a URL fragment, or an id
 * selector that merely contains a `#`.
 */
const HEX_SELECTOR = {
  selector:
    "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
  message:
    "Raw hex color. Design System v2 forbids raw hex in components — read it from the active theme instead (`const colors = useColors()`, from `@th/ui-native`). React Native has no CSS variables, so the palette module in `@th/ui-native` (packages/ui-native/src/palette.ts) is the only sanctioned home for a hex literal; if the value you need isn't there, add a NAMED token to it with a doc comment. See docs/design/design-system-v2.md. If the literal is genuinely un-tokenisable (Expo native config, vendor brand mark), add the file to eslint-color-permanents.mjs with a written reason.",
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      ".expo/**",
      // Generated native prebuild output — gitignored build artifacts, not source.
      "android/**",
      "ios/**",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [...colorPermanents, ...DS_RULE_EXCLUDES],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // Ignore inline `eslint-disable` comments entirely. Two reasons:
      //   1. REQUIRED, not cosmetic. This app carries pre-existing disable directives for
      //      PLUGIN rules this narrow config deliberately does not load
      //      (`react-hooks/exhaustive-deps`, `@typescript-eslint/no-require-imports`). ESLint 9
      //      hard-errors with "Definition for rule '…' was not found" on a directive naming an
      //      unresolvable rule — verified: removing this line produces 9 errors on comments that
      //      have nothing to do with color, red-CI'ing `turbo run lint`. (Directives naming core
      //      rules like `no-console` do NOT error — the rule resolves, it's just not enabled —
      //      so the plugin ones are the whole problem.)
      //   2. It hardens the gate: no one can `// eslint-disable-next-line no-restricted-syntax`
      //      past the color rule. A genuine exemption must be argued for in
      //      eslint-color-permanents.mjs, in writing.
      // The cost is that ESLint then reports each now-inert directive as a WARNING (~20 of
      // them). That is why the `lint` script runs `--quiet`: warnings are noise here, and only
      // errors gate CI. Adopting the real rulesets later makes those directives live again.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-restricted-syntax": ["error", HEX_SELECTOR],
    },
  },
];
