import type { Plugin } from "vite";

const USE_CLIENT_DIRECTIVE_PATTERN = /^(?:"use client"|'use client');?\s*/;

/**
 * Removes the `"use client"` directive from modules during the Storybook build.
 *
 * Next.js relies on the directive to flag components as client-only, but Vite treats
 * it as an unknown module-level directive and emits noisy warnings. Stripping it at
 * build-time keeps the source files unchanged while aligning with Storybook's React
 * Native Web expectations.
 */
export const removeClientDirective = (): Plugin => ({
  name: "storybook-remove-client-directive",
  enforce: "pre",
  transform(code, id) {
    if (id.includes("node_modules")) {
      return null;
    }

    if (
      !id.endsWith(".tsx") &&
      !id.endsWith(".ts") &&
      !id.endsWith(".jsx") &&
      !id.endsWith(".js")
    ) {
      return null;
    }

    const trimmed = code.replace(/^\ufeff/, "");
    if (
      !trimmed.startsWith('"use client"') &&
      !trimmed.startsWith("'use client'")
    ) {
      return null;
    }

    return {
      code: code
        .replace(/^\ufeff?/, "")
        .replace(USE_CLIENT_DIRECTIVE_PATTERN, ""),
      map: null,
    };
  },
});
