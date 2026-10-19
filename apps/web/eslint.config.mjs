import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import unusedImports from "eslint-plugin-unused-imports";
import tseslint from "typescript-eslint";

import { hexAllowlist } from "./eslint-hex-allowlist.mjs";
import { whitePermanents } from "./eslint-white-permanents.mjs";

/**
 * Next.js dynamic-route dirs are literal `[slug]` / `[...slug]` on disk, but `[` and `]` are
 * glob character-class metacharacters — an unescaped `[slug]` matches the chars s|l|u|g, NOT the
 * directory. Escape them so allowlist paths actually match. (Without this the whole allowlist
 * silently no-ops and the rule red-CIs on pre-existing debt.)
 */
const escapeGlob = (p) => p.replace(/[[\]]/g, "\\$&");

/** Files the design-system color rules never apply to. */
const DS_RULE_EXCLUDES = [
  "**/__tests__/**",
  "**/*.test.{ts,tsx}",
  "**/*.stories.{ts,tsx}",
  "**/mocks/**",
  "src/shims/**",
];

/**
 * Design System v2 — "no raw hex in components" (docs/design/design-system-v2.md).
 *
 * Bans a BARE hex color literal (`"#FF5721"`, `'#fff'`). Colors come from semantic tokens.
 * Hex inside a `var()` fallback — `var(--accent, #E2481D)` — is the SANCTIONED pattern for
 * raw-CSS/inline-style contexts (the fallback is what SSR paints) and is NOT matched here,
 * because the selector is anchored to the whole string value.
 *
 * `hexAllowlist` is a shrinking ratchet of pre-existing debt — see eslint-hex-allowlist.mjs.
 */
const HEX_SELECTOR = {
  selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
  message:
    "Raw hex color. Design System v2 forbids raw hex in components — use a semantic token ($accent, $colorMuted, …), or `var(--token, #stubFallback)` in raw-CSS/inline-style contexts. See docs/design/design-system-v2.md. If this is canvas/MapLibre/a data palette/third-party brand color, add the file to eslint-hex-allowlist.mjs with a reason.",
};

/**
 * Raw white (`rgba(255,255,255,α)`) — authored for the retired Ember dark theme; invisible on the
 * shipped Stub cream. Unlike the hex rule this was NOT grandfathered: all 53 offending files were
 * migrated first. Only genuinely-correct light-on-fixed-dark surfaces are exempt
 * (eslint-white-permanents.mjs). Comments are not Literals, so prose describing the anti-pattern
 * is unaffected.
 */
const WHITE_SELECTOR = {
  selector: "Literal[value=/rgba\\(\\s*255\\s*,\\s*255\\s*,\\s*255/]",
  message:
    "Raw white rgba(255,255,255,…). This was the retired Ember dark theme's chrome and is invisible on the Stub cream default. Use an ink tint (rgba(33,28,22,α)), a semantic token ($color/$colorMuted/$borderColorSoft), or — for light-on-dark chrome — hexToRgba(onStructure, α) / color-mix(in srgb, var(--onStructure) X%, transparent). See docs/design/design-system-v2.md. Only add to eslint-white-permanents.mjs if the surface is dark in EVERY theme (with a stated reason).",
};

/**
 * The bare `white` keyword — the spelling that slipped past both selectors above and hid a real
 * light-on-light bug (a white glyph on #EFE7D6 paper). Shares whitePermanents' exemptions.
 */
const WHITE_KEYWORD_SELECTOR = {
  selector: "Literal[value=/^(?:white|WHITE)$/]",
  message:
    'The bare "white" keyword. If it sits on an accent fill use $onBrandSecondary; on an ink/structure fill use $onStructure; on a light surface it is invisible — use $color/$colorMuted. See docs/design/design-system-v2.md. Genuine exceptions (QR quiet zones, fixed-dark surfaces) go in eslint-white-permanents.mjs with a stated reason.',
};

/**
 * The trusted-client-IP readers in `@th/trpc/client-ip` read
 * `x-th-verified-client-ip`, which only apps/api's `verified-client-ip` hook
 * makes trustworthy (it strips inbound copies and re-stamps the header). In
 * this app any client can set it, so these names are banned here. The
 * forward helpers in the same module (`signClientIpForward`,
 * `verifyClientIpForward`, …) stay allowed. Same list in apps/jobs, apps/mcp,
 * apps/audio-transcoder, apps/scanner and apps/mobile eslint configs.
 */
const TRUSTED_CLIENT_IP_IMPORT_NAMES = [
  "resolveTrustedClientIp",
  "VERIFIED_CLIENT_IP_HEADER",
  "TRUSTED_CLIENT_IP_HEADER_PRECEDENCE",
];
const TRUSTED_CLIENT_IP_MESSAGE =
  "Only apps/api may use the trusted client IP: x-th-verified-client-ip is trustworthy only behind apps/api's verified-client-ip hook, and anyone can send it anywhere else. Use resolveClientIp, or forward the IP with signClientIpForward.";

const nextRules = {
  ...nextPlugin.configs.recommended.rules,
  ...nextPlugin.configs["core-web-vitals"].rules,
  "@next/next/no-html-link-for-pages": "off",
};

const reactHooksRules =
  reactHooks.configs?.recommended?.rules ?? {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
  };

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "storybook-static/**",
      "**/storybook-static/**",
      "out/**",
      "build/**",
  ".tamagui/**",
      "next-env.d.ts",
      "eslint.config.mjs",
      "*.config.mjs",
      "*.config.js",
      "babel.config.js",
      ".storybook/preview.tsx",
      "**/*.stories.tsx",
    ],
  },
  js.configs.recommended,
  // Typed linting rules require parserServices. Scope them to TS/TSX only so
  // tooling files (e.g. `*.cjs`) don't fail the lint run.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}", ".storybook/**/*.{ts,tsx}", ".storybook/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        JSX: true,
      },
      parserOptions: {
        projectService: true,
        allowDefaultProject: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@next/next": nextPlugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "unused-imports": unusedImports,
    },
    settings: {
      next: {
        rootDir: ["apps/web"],
      },
    },
    rules: {
      ...nextRules,
      ...reactHooksRules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message:
                "Use NextLinkAnchor from @th/ui for links so styling/behavior stays consistent across the design system.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/array-type": "off",
      "react-refresh/only-export-components": "off",
      // Disabled: `t("key") as string` is pervasive and intentional — the
      // translation function returns `string | undefined` but callers know
      // the key exists. Fixing 1100+ call sites isn't worth the churn.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Disabled: tRPC/auth error shapes are `unknown`; safe usage is
      // validated at runtime via normalizeError. These rules generate 700+
      // false positives across mutation catch blocks.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      // Warn instead of error — these are real issues but shouldn't block CI.
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-optional-chain": "warn",
      "@typescript-eslint/require-await": "warn",
      "@typescript-eslint/prefer-regexp-exec": "off",
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/prefer-for-of": "off",
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
      "@typescript-eslint/consistent-indexed-object-style": "off",
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/prefer-as-const": "warn",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      // jsx-a11y plugin not installed — disable rules that reference it
      "jsx-a11y/no-static-element-interactions": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
      "jsx-a11y/media-has-caption": "off",
      "jsx-a11y/click-events-have-key-events": "off",
      // Use unused-imports plugin instead of built-in — it can auto-fix
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": ["warn", {
        vars: "all",
        varsIgnorePattern: "^_",
        args: "after-used",
        argsIgnorePattern: "^_",
        caughtErrors: "none",
      }],
      "prefer-const": "warn",
      "no-restricted-imports": [
        "warn",
        {
          paths: [
            {
              name: "next/link",
              message:
                "Use NextLinkAnchor from @th/ui for links so styling/behavior stays consistent across the design system.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      "@next/next": nextPlugin,
    },
    settings: {
      next: {
        rootDir: ["apps/web"],
      },
    },
    rules: nextRules,
  },
  {
    // Host-page scripts are ES5 on purpose (old browsers on customers' sites). ES5 has no
    // optional catch binding, so `catch (_e) {}` must keep its parameter.
    files: ["public/embed/**/*.js"],
    rules: {
      "no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
  {
    // Node tooling under scripts/ — these run under `node`, not in the browser, so they need Node
    // globals (console/process/URL). NOTE: this deliberately does NOT ignore them — the design
    // system's colour rules are scoped to `src/**`, so a lint script that necessarily *mentions*
    // hex (rule messages, self-test fixtures) is unaffected, but real bugs here are still caught.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["src/shims/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",
    },
  },
  {
    files: ["**/__tests__/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  // ── Design System v2: no raw color literals ─────────────────────────────────
  // Two selectors with DIFFERENT exemption lists. They must be layered, because two config
  // objects setting `no-restricted-syntax` for the same file don't merge — the last one wins
  // and would silently disable the other selector. Order matters; later blocks override.
  //
  //   file in neither list      → block 2 wins → HEX + WHITE enforced
  //   file in hexAllowlist only → block 1      → WHITE enforced, hex exempt (shrinking debt)
  //   file in whitePermanents   → block 3      → HEX enforced, white exempt (principled)
  //   file in both             → block 3 ignores it → rule off
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...whitePermanents.map(escapeGlob), ...DS_RULE_EXCLUDES],
    rules: { "no-restricted-syntax": ["error", WHITE_SELECTOR, WHITE_KEYWORD_SELECTOR] },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      ...hexAllowlist.map(escapeGlob),
      ...whitePermanents.map(escapeGlob),
      ...DS_RULE_EXCLUDES,
    ],
    rules: { "no-restricted-syntax": ["error", HEX_SELECTOR, WHITE_SELECTOR, WHITE_KEYWORD_SELECTOR] },
  },
  {
    files: whitePermanents.map(escapeGlob),
    ignores: [...hexAllowlist.map(escapeGlob), ...DS_RULE_EXCLUDES],
    rules: { "no-restricted-syntax": ["error", HEX_SELECTOR] },
  },
  {
    files: [".storybook/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // The typescript-eslint copy of the rule, NOT core `no-restricted-imports`:
  // the core rule is already configured above (next/link, at "warn"), and a
  // second config object setting it would replace those options, not merge
  // with them. This is a separate rule, so it can be "error" on its own.
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@th/trpc/client-ip",
              importNames: TRUSTED_CLIENT_IP_IMPORT_NAMES,
              message: TRUSTED_CLIENT_IP_MESSAGE,
            },
          ],
          patterns: [
            {
              group: ["**/transport/trpc/src/client-ip", "**/transport/trpc/src/client-ip.*"],
              importNames: TRUSTED_CLIENT_IP_IMPORT_NAMES,
              message: TRUSTED_CLIENT_IP_MESSAGE,
            },
          ],
        },
      ],
    },
  },
);
