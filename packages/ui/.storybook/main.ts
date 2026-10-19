import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StorybookConfig } from "@storybook/react-vite";

import { removeClientDirective } from "./plugins/remove-client-directive";

const require = createRequire(import.meta.url);
const storybookDir = dirname(fileURLToPath(import.meta.url));
const resolveStorybookPath = (...segments: string[]) =>
  resolve(storybookDir, ...segments);
const resolveModuleRoot = (specifier: string) =>
  dirname(require.resolve(specifier));
const resolveRnLibraryPath = (...segments: string[]) =>
  resolveStorybookPath("mocks/react-native-libraries", ...segments);
const reactNativeWebPath = resolveModuleRoot("react-native-web/package.json");

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-essentials", "@storybook/addon-interactions"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  docs: {
    autodocs: "tag",
  },
  typescript: {
    reactDocgen: "react-docgen-typescript",
  },
  viteFinal: async (config) => {
    (config.plugins ??= []).push(removeClientDirective() as never);

    const existingAlias = config.resolve?.alias ?? [];
    const normalizedAlias = Array.isArray(existingAlias)
      ? existingAlias
      : Object.entries(existingAlias).map(([find, replacement]) => ({
          find,
          replacement,
        }));

    config.resolve = {
      ...(config.resolve ?? {}),
      alias: [
        ...normalizedAlias,
        {
          find: "react-native/Libraries/Utilities/codegenNativeComponent",
          replacement: resolveRnLibraryPath(
            "Utilities/codegenNativeComponent.ts",
          ),
        },
        {
          find: "react-native/Libraries/Pressability/PressabilityDebug",
          replacement: resolveRnLibraryPath(
            "Pressability/PressabilityDebug.ts",
          ),
        },
        {
          find: "react-native/Libraries/Renderer/shims/ReactNativeViewConfigRegistry",
          replacement: resolveRnLibraryPath(
            "Renderer/shims/ReactNativeViewConfigRegistry.ts",
          ),
        },
        {
          find: "react-native/Libraries/Renderer/shims/ReactNative",
          replacement: resolveRnLibraryPath("Renderer/shims/ReactNative.ts"),
        },
        {
          find: "react-native/Libraries/Renderer/shims/ReactFabric",
          replacement: resolveRnLibraryPath("Renderer/shims/ReactFabric.ts"),
        },
        {
          find: "react-native/Libraries/ReactNative/ReactFabricPublicInstance/ReactFabricPublicInstance",
          replacement: resolveRnLibraryPath(
            "ReactNative/ReactFabricPublicInstance/ReactFabricPublicInstance.ts",
          ),
        },
        {
          find: "react-native",
          replacement: resolveStorybookPath("mocks/react-native.ts"),
        },
        {
          find: "react-native-reanimated",
          replacement: resolveStorybookPath(
            "mocks/react-native-reanimated.tsx",
          ),
        },
        {
          find: "@shopify/react-native-skia",
          replacement: resolveStorybookPath(
            "mocks/shopify-react-native-skia.tsx",
          ),
        },
      ],
      dedupe: [...(config.resolve?.dedupe ?? []), "react", "react-dom"],
    };

    config.define = {
      ...(config.define ?? {}),
      "process.env.TAMAGUI_TARGET": JSON.stringify("web"),
    };

    config.optimizeDeps = {
      ...(config.optimizeDeps ?? {}),
      include: [
        ...(config.optimizeDeps?.include ?? []),
        "react",
        "react-dom",
        "react-native-web",
        "tamagui",
        "@tamagui/core",
      ],
      exclude: [
        ...(config.optimizeDeps?.exclude ?? []),
        "react-native-reanimated",
        "@shopify/react-native-skia",
      ],
    };

    return config;
  },
};

export default config;
