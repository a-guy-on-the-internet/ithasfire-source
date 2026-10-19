import { parser as tsParser } from "typescript-eslint";

import { colorPermanents } from "./eslint-color-permanents.mjs";

/**
 * `@th/ui` lint — DESIGN-SYSTEM COLOR RULES ONLY.
 *
 * This config is deliberately narrow. It does NOT adopt the TS/react rulesets that `apps/web`
 * runs: this package was previously unlinted entirely, so turning on a full ruleset would
 * surface a mountain of unrelated pre-existing findings and red-CI `turbo run lint`. The single
 * job here is to keep the design system's own atoms free of raw color literals — these are the
 * canonical components, so they must be exemplary.
 *
 * Scope is all of `src/**` EXCEPT `src/ui/tamagui/tokens/**`, which is the sanctioned palette
 * home — raw hex BELONGS there and is not linted. (`src/ui/shell/**` and `src/ui/event-page/**`
 * were audited clean at the time this widened, so covering them costs nothing today and stops
 * them drifting tomorrow — which is the whole point of a gate.)
 *
 * `eslint` / `typescript-eslint` resolve from the workspace root rather than being declared as
 * devDeps of this package. That is deliberate and safe here: `.npmrc` pins `nodeLinker=hoisted`
 * + `shamefullyHoist=true`, so root devDeps are resolvable from every package. Declaring them
 * locally forced a full re-resolve that floated unrelated deps (tsx, @better-auth) — churn this
 * change has no business making. If the repo ever moves off hoisted linking, add
 * `eslint` + `typescript-eslint` to packages/ui devDependencies in a dedicated dependency change.
 *
 * See docs/design/design-system-v2.md.
 */

/** Files the design-system color rules never apply to. */
const DS_RULE_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  "**/*.stories.{ts,tsx}",
  // The sanctioned palette home — raw hex belongs here by definition.
  "src/ui/tamagui/tokens/**",
  // Storybook harness + mocks are not shipped surfaces.
  ".storybook/**",
  "**/mocks/**",
];

/**
 * Design System v2 — "no raw hex in components".
 *
 * Bans a BARE hex color literal (`"#FF5721"`, `'#fff'`). Hex inside a `var()` fallback —
 * `var(--accent, #E2481D)` — is the SANCTIONED pattern for raw-CSS/inline-style contexts (the
 * fallback is what SSR paints) and is NOT matched here, because the selector is anchored to the
 * whole string value.
 */
const HEX_SELECTOR = {
  selector:
    "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
  message:
    "Raw hex color. Design System v2 forbids raw hex in components — use a semantic token ($accent, $colorMuted, …), `theme.x?.val ?? stubTheme.x` when you need a resolved value, or `var(--token, #stubFallback)` in raw-CSS contexts. Raw hex belongs in src/ui/tamagui/tokens/ only. See docs/design/design-system-v2.md. If the value is a genuinely theme-independent, contrast-tuned constant, add the file to eslint-color-permanents.mjs with a reason.",
};

/**
 * Raw white (`rgba(255,255,255,α)`) — authored for the retired Ember dark theme; invisible on the
 * shipped Stub cream. Comments are not Literals, so prose describing the anti-pattern is
 * unaffected.
 */
const WHITE_SELECTOR = {
  selector: "Literal[value=/rgba\\(\\s*255\\s*,\\s*255\\s*,\\s*255/]",
  message:
    "Raw white rgba(255,255,255,…). This was the retired Ember dark theme's chrome and is invisible on the Stub cream default. Use a semantic token ($color/$colorMuted/$borderColorSoft/$surfaceOverlay), or hexToRgba(theme.color?.val ?? stubTheme.color, α) for a theme-tracking tint. For light-on-a-fixed-dark-fill use $onStructure / $onBrandSecondary. See docs/design/design-system-v2.md.",
};

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "storybook-static/**",
      "**/storybook-static/**",
      ".tamagui/**",
      // Playwright's bundled report assets — build artifacts, not source.
      "playwright/.cache/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...colorPermanents, ...DS_RULE_EXCLUDES],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    linterOptions: {
      // Ignore inline `eslint-disable` comments entirely. Two reasons:
      //   1. This package carries pre-existing disable directives for rules this narrow config
      //      deliberately does not load (react-hooks, @typescript-eslint, jsx-a11y). ESLint 9
      //      errors on a directive naming an unknown rule, which would red-CI on comments that
      //      have nothing to do with color.
      //   2. It hardens the gate: no one can `// eslint-disable-next-line no-restricted-syntax`
      //      past the color rules. A genuine exemption must be argued for in
      //      eslint-color-permanents.mjs, in writing.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-restricted-syntax": ["error", HEX_SELECTOR, WHITE_SELECTOR],
    },
  },
];
