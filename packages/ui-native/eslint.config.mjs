import { parser as tsParser } from "typescript-eslint";

/**
 * `@th/ui-native` lint — DESIGN-SYSTEM COLOR RULE ONLY.
 *
 * This config is deliberately narrow, and mirrors `apps/scanner/eslint.config.mjs` (which in turn
 * mirrors `packages/ui/eslint.config.mjs`). It does NOT adopt the TS/react rulesets that
 * `apps/web` runs. The single job here is to keep raw color literals out of everything in this
 * package except the palette module. Widening this to a real ruleset is a worthwhile follow-up,
 * but it is its own change with its own cleanup budget — not a rider on a color gate.
 *
 * ## Why this config exists separately from the scanner's
 *
 * The palette used to live at `apps/scanner/src/ui/palette.ts`, where the scanner's gate covered
 * both it and every screen that consumed it. Extracting the token layer into this package moved
 * the palette OUT of that gate's reach: an app-level eslint run only lints the app. Without this
 * file the one place raw hex is allowed would be the one place nothing checks the surrounding
 * files, and a hex literal added to `primitives.tsx` or `styles.ts` would sail through. The rule
 * therefore travels with the code.
 *
 * ## Why the rule is hex-only (and not the web's token rule)
 *
 * React Native cannot use CSS variables, so `@th/ui`'s web pattern — `var(--accent, #E2481D)` —
 * is meaningless here. There is no runtime cascade to resolve it. The rule is therefore simpler
 * and stricter: colors come from the palette module, `src/palette.ts`, which is the RN analogue of
 * `packages/ui/src/ui/tamagui/tokens/`. Raw hex belongs THERE and nowhere else; components import
 * from it. (`packages/ui` also bans raw `rgba(255,255,255,…)`; that rule is intentionally NOT
 * ported — on the web it flags Ember-era white that is invisible on the shipped Stub cream,
 * whereas the Ember theme here is dark and its FIXED camera-overlay values are deliberately
 * light-on-black. It would fire on correct values in palette.ts alone.)
 *
 * `eslint` / `typescript-eslint` resolve from the workspace root rather than being declared as
 * devDeps of this package. That is deliberate and safe here: `.npmrc` pins `nodeLinker=hoisted`
 * + `shamefullyHoist=true`, so root devDeps are resolvable from every package. Declaring them
 * locally would force a lockfile re-resolve that floats unrelated deps. If the repo ever moves off
 * hoisted linking, add `eslint` + `typescript-eslint` to this package's devDependencies in a
 * dedicated dependency change.
 *
 * See docs/design/design-system-v2.md.
 */

/** Files the design-system color rule never applies to. */
const DS_RULE_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  // The sanctioned palette home — raw hex belongs here by definition. This is the ONE file in
  // the package allowed to name a color, and its own docblock states the rule. It holds BOTH
  // themes (Ember + Stub) plus the theme-invariant `FIXED` set; components read it through
  // `useColors()` (src/theme.tsx) and never name a value themselves.
  "src/palette.ts",
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
    "Raw hex color. Design System v2 forbids raw hex in components — read it from the active theme instead (`const colors = useColors()`, from `@th/ui-native`). React Native has no CSS variables, so the palette module `packages/ui-native/src/palette.ts` is the only sanctioned home for a hex literal in this package; if the value you need isn't there, add a NAMED token to it with a doc comment. See docs/design/design-system-v2.md. If the literal is genuinely un-tokenisable (Expo native config, vendor brand mark), it belongs in the consuming app behind an entry in that app's eslint-color-permanents.mjs, with a written reason.",
};

export default [
  {
    ignores: ["**/node_modules/**", "dist/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    ignores: DS_RULE_EXCLUDES,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // Ignore inline `eslint-disable` comments entirely — same rationale as the scanner's config:
      //   1. REQUIRED, not cosmetic. This package carries a `react-hooks/exhaustive-deps`
      //      directive (src/theme.tsx) for a PLUGIN rule this narrow config deliberately does not
      //      load. ESLint 9 hard-errors with "Definition for rule '…' was not found" on a
      //      directive naming an unresolvable rule, which would red-CI `turbo run lint`.
      //   2. It hardens the gate: no one can `// eslint-disable-next-line no-restricted-syntax`
      //      past the color rule. A genuine exemption must be argued for in writing.
      // The cost is that ESLint reports each now-inert directive as a WARNING; that is why the
      // `lint` script runs `--quiet`. Adopting the real rulesets later makes those directives live
      // again.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-restricted-syntax": ["error", HEX_SELECTOR],
    },
  },
];
