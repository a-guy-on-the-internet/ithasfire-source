import { parser as tsParser } from "typescript-eslint";

/**
 * `jobs` lint: ONE rule, the trusted-client-IP import guard.
 *
 * `@th/trpc/client-ip`'s `resolveTrustedClientIp`,
 * `VERIFIED_CLIENT_IP_HEADER` and `TRUSTED_CLIENT_IP_HEADER_PRECEDENCE` read
 * `x-th-verified-client-ip`. Only apps/api's `verified-client-ip` hook makes
 * that header trustworthy (it strips inbound copies and re-stamps them).
 * Anywhere else, the client can set it. Same list in the apps/web,
 * apps/scanner, apps/mobile, apps/mcp and apps/audio-transcoder eslint
 * configs.
 *
 * Deliberately narrow, like `apps/scanner/eslint.config.mjs`: this app had no
 * lint at all, and a full ruleset is its own change with its own cleanup.
 * `eslint` / `typescript-eslint` resolve from the workspace root
 * (`nodeLinker=hoisted`), as they do for scanner. Inline `eslint-disable`
 * directives are off, so the guard can't be waved past and directives naming
 * plugin rules this config doesn't load don't hard-error. ESLint warns about
 * each ignored directive, which is why the `lint` script runs `--quiet`.
 */
export default [
  {
    ignores: ["**/node_modules/**", "dist/**"],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: {
      parser: tsParser,
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@th/trpc/client-ip",
              importNames: [
                "resolveTrustedClientIp",
                "VERIFIED_CLIENT_IP_HEADER",
                "TRUSTED_CLIENT_IP_HEADER_PRECEDENCE",
              ],
              message:
                "Only apps/api may use the trusted client IP: x-th-verified-client-ip is trustworthy only behind apps/api's verified-client-ip hook, and anyone can send it anywhere else.",
            },
          ],
          // A relative path straight to the source file, with or without extension.
          patterns: [
            {
              group: ["**/transport/trpc/src/client-ip", "**/transport/trpc/src/client-ip.*"],
              importNames: [
                "resolveTrustedClientIp",
                "VERIFIED_CLIENT_IP_HEADER",
                "TRUSTED_CLIENT_IP_HEADER_PRECEDENCE",
              ],
              message:
                "Only apps/api may use the trusted client IP: x-th-verified-client-ip is trustworthy only behind apps/api's verified-client-ip hook, and anyone can send it anywhere else.",
            },
          ],
        },
      ],
    },
  },
];
