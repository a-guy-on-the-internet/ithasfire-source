import path from "node:path";

import {
  buildRelativeAliasMap,
  type AliasMap,
  buildResolvedAliasMap,
} from "./react-native-aliases";

export type { AliasMap };

export type ViteAliasEntry = { find: string | RegExp; replacement: string };

/**
 * Vite/Vitest alias entries.
 *
 * - Uses absolute paths.
 * - Includes the React Native shims used by web.
 */
export const buildVitestAliasEntries = (
  projectRoot: string,
): ViteAliasEntry[] => {
  const workspaceRoot = path.resolve(projectRoot, "../..");

  const rnAliases = buildResolvedAliasMap(projectRoot);

  return [
    // Primary web alias
    { find: "@", replacement: path.resolve(projectRoot, "src") },

    // Workspace source aliases used in tests
    {
      find: /^@th\/schema\/(.*)$/,
      replacement: path.resolve(workspaceRoot, "packages/schema/src/$1"),
    },
    {
      find: "@th/schema",
      replacement: path.resolve(workspaceRoot, "packages/schema/src/index.ts"),
    },
    {
      find: /^@th\/types\/(.*)$/,
      replacement: path.resolve(workspaceRoot, "packages/types/src/$1"),
    },
    {
      find: "@th/types",
      replacement: path.resolve(workspaceRoot, "packages/types/src/index.ts"),
    },
    {
      find: /^@th\/core\/lib\/embeds$/,
      replacement: path.resolve(
        workspaceRoot,
        "packages/core/src/lib/embeds/index.ts",
      ),
    },
    {
      find: /^@th\/core\/(.*)$/,
      replacement: path.resolve(workspaceRoot, "packages/core/src/$1"),
    },
    {
      find: "@th/core",
      replacement: path.resolve(workspaceRoot, "packages/core/src/index.ts"),
    },

    // Rich text HTML sanitization helpers (pulled into @th/ui event rendering)
    {
      find: /^@th\/services-rich-text-html\/(.*)$/,
      replacement: path.resolve(
        workspaceRoot,
        "packages/service/rich-text-html/src/$1",
      ),
    },
    {
      find: "@th/services-rich-text-html",
      replacement: path.resolve(
        workspaceRoot,
        "packages/service/rich-text-html/src/index.ts",
      ),
    },

    // React Native web shims
    ...Object.entries(rnAliases).map(([find, replacement]) => ({
      find,
      replacement,
    })),
  ];
};

/**
 * Next.js Turbopack resolve aliases.
 *
 * Turbopack expects relative paths (strings) rather than resolved absolute paths.
 */
export const buildNextTurbopackAliasMap = (): AliasMap => {
  return buildRelativeAliasMap();
};

/**
 * Next.js Webpack aliases.
 *
 * Webpack expects resolved absolute paths.
 */
export const buildNextWebpackAliasMap = (projectRoot: string): AliasMap => {
  return buildResolvedAliasMap(projectRoot);
};
