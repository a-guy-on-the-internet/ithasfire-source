import { resolve } from "node:path";

export type AliasMap = Record<string, string>;

export type WebRnShimsOptions = {
  /**
   * Map react-native and other RN-first packages to web-safe shim entrypoints.
   * Default: true.
   */
  shimCoreReactNative?: boolean;

  /**
   * Absolute path to `apps/web` (or other consumer root). Used when resolving alias targets.
   */
  projectRoot: string;

  /**
   * Path (relative to projectRoot) where the shim files live.
   * Default: `src/shims`.
   */
  shimsDir?: string;
};

const defaultShimTargets = [
  "react-native",
  "react-native-gesture-handler",
  "react-native-reanimated",
  "@shopify/react-native-skia",
] as const;

const defaultStaticEntries = [
  ["@", "./src"],
  [
    "react-native/Libraries/Pressability/PressabilityDebug",
    "./src/shims/react-native-pressability-debug.tsx",
  ],
  [
    "react-native/Libraries/Pressability/PressabilityDebug.js",
    "./src/shims/react-native-pressability-debug.tsx",
  ],
  [
    "react-native/Libraries/Animated/Animated",
    "./src/shims/react-native-animated.ts",
  ],
  [
    "react-native/Libraries/Animated/Animated.js",
    "./src/shims/react-native-animated.ts",
  ],
] as const;

const toShimsPath = (shimsDir: string, id: string) => {
  // For scoped packages like @shopify/react-native-skia we want a deterministic filename.
  const safe = id.replaceAll("/", "-").replaceAll("@", "");
  // Prefer .tsx for component shims; fall back to .ts for small module stubs.
  if (safe.endsWith("-animated")) return `./${shimsDir}/${safe}.ts`;
  return `./${shimsDir}/${safe}.tsx`;
};

export const buildRelativeAliasMap = (opts: WebRnShimsOptions): AliasMap => {
  const shimsDir = (opts.shimsDir ?? "src/shims").replace(/^\.\//, "");

  const staticEntries: AliasMap = Object.fromEntries(defaultStaticEntries);

  const targetEntries: AliasMap = {};
  for (const id of defaultShimTargets) {
    if (id === "react-native" && opts.shimCoreReactNative === false) {
      continue;
    }

    targetEntries[id] = toShimsPath(shimsDir, id);
  }

  return {
    ...staticEntries,
    ...targetEntries,
  };
};

/**
 * Returns an alias map where values are absolute paths.
 * Use for Webpack/Vitest/Storybook resolvers.
 */
export const buildResolvedAliasMap = (opts: WebRnShimsOptions): AliasMap => {
  const relative = buildRelativeAliasMap(opts);
  return Object.fromEntries(
    Object.entries(relative).map(([find, replacement]) => [
      find,
      resolve(opts.projectRoot, replacement),
    ]),
  );
};
