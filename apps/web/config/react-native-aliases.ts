import { join, resolve } from "node:path";

export type AliasMap = Record<string, string>;

const shimTargets: Array<[string, string]> = [
  ["react-native", "./src/shims/react-native.tsx"],
  [
    "react-native-gesture-handler",
    "./src/shims/react-native-gesture-handler.tsx",
  ],
  ["react-native-reanimated", "./src/shims/react-native-reanimated.tsx"],
  ["@shopify/react-native-skia", "./src/shims/react-native-skia.tsx"],
];

const staticEntries: AliasMap = {
  "@": "./src",
  "react-native/Libraries/Utilities/codegenNativeComponent":
    "./src/shims/react-native-codegen-native-component.tsx",
  "react-native/Libraries/Utilities/codegenNativeComponent.js":
    "./src/shims/react-native-codegen-native-component.tsx",
  "react-native/Libraries/Pressability/PressabilityDebug":
    "./src/shims/react-native-pressability-debug.tsx",
  "react-native/Libraries/Pressability/PressabilityDebug.js":
    "./src/shims/react-native-pressability-debug.tsx",
  "react-native/Libraries/Animated/Animated":
    "./src/shims/react-native-animated.ts",
  "react-native/Libraries/Animated/Animated.js":
    "./src/shims/react-native-animated.ts",
};

export const buildRelativeAliasMap = (): AliasMap => {
  return shimTargets.reduce<AliasMap>(
    (acc, [alias, target]) => {
      acc[alias] = target;
      return acc;
    },
    { ...staticEntries },
  );
};

/**
 * Returns an alias map where values are absolute paths.
 * Useful for tooling that expects resolved paths (Vitest/Webpack/Storybook).
 */
export const buildResolvedAliasMap = (projectRoot: string): AliasMap => {
  const relative = buildRelativeAliasMap();
  return Object.fromEntries(
    Object.entries(relative).map(([find, replacement]) => [
      find,
      resolve(projectRoot, replacement),
    ]),
  );
};

/**
 * Helper for configs that want to resolve from an arbitrary base folder.
 * Kept for backwards compatibility if some config wants join semantics.
 */
export const resolveFrom = (baseDir: string, target: string) =>
  join(baseDir, target);
