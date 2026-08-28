import type { StorybookConfig } from "@storybook/react-vite";
import path from "path";
import { fileURLToPath } from "url";
import { buildResolvedAliasMap } from "@th/web-rn-shims";

/*
 * Step 3: addons + full preview (Tamagui/RN providers) + minimal Vite aliases.
 * NO optimizeDeps, NO define, NO custom plugins.
 */

// esbuild-register evaluates this file in CJS mode, so import.meta.dirname
// is undefined. Fall back to __dirname when available.
const _dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const webRoot = path.resolve(_dirname, "..");
const monoRoot = path.resolve(webRoot, "../..");

const rnAliases = buildResolvedAliasMap({ projectRoot: webRoot });

const storybookConfig: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(js|jsx|ts|tsx)"],
  addons: ["@storybook/addon-essentials", "@storybook/addon-interactions"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  async viteFinal(config) {
    const { mergeConfig } = await import("vite");
    return mergeConfig(config, {
      esbuild: {
        // Automatic JSX runtime — no need for `import React` in every file.
        jsx: "automatic",
      },
      define: {
        "process.env": "{}",
        "process.platform": '""',
        "process.version": '""',
      },
      resolve: {
        alias: {
          ...rnAliases,
          "@th/ui": path.resolve(monoRoot, "packages/ui/src"),
        },
        extensions: [
          ".web.tsx",
          ".web.ts",
          ".web.js",
          ".tsx",
          ".ts",
          ".js",
          ".jsx",
          ".json",
        ],
      },
      server: {
        fs: {
          allow: [monoRoot],
        },
      },
    });
  },
};

export default storybookConfig;
