// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // The trusted-client-IP readers in `@th/trpc/client-ip` read
    // `x-th-verified-client-ip`, which only apps/api's `verified-client-ip`
    // hook makes trustworthy; anywhere else the client sets it. Same list in
    // the apps/web, apps/scanner, apps/jobs, apps/mcp and
    // apps/audio-transcoder eslint configs.
    files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
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
]);
