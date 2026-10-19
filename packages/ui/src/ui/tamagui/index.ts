import { createAnimations } from "@tamagui/animations-react-native";
import { createAnimations as createCssAnimations } from "@tamagui/animations-css";
import { Easing, Platform } from "react-native";
import {
  TamaguiProvider,
  createFont,
  createShorthands,
  createTamagui,
  createTokens,
} from "tamagui";
import { createElement } from "react";
import type { ComponentProps, ReactNode } from "react";

import {
  colorTokens as baseColorTokens,
  darkTheme as darkColorTheme,
  lightTheme as lightColorTheme,
  stubTheme as stubColorTheme,
  THEME_TOKEN_GROUPS,
  getDarkThemeSnapshot,
  getLightThemeSnapshot,
  getStubThemeSnapshot,
  getThemeTokenKeys,
} from "./tokens/colors";
export type { ThemeTokenKey } from "./tokens/colors";
import { borderTokens } from "./tokens/border";
import { densityTokens, resolveDensity, HIT_MIN } from "./tokens/density";
import { vizTokens, vizSeries } from "./tokens/dataviz";
import { elevationTokens, getShadowOverflowPx } from "./tokens/elevation";
import * as imagery from "./tokens/imagery";
import { motionTokens } from "./tokens/motion";
import { radiusTokens } from "./tokens/radius";
import { sizeTokens } from "./tokens/size";
import { spaceTokens } from "./tokens/space";
import { typographyTokens } from "./tokens/typography";
import { zIndexTokens } from "./tokens/z-index";

// Swiss International Typographic Style — extreme scale contrast.
// Headlines are massive; body is restrained and readable.
const fontSizeScale = {
  1: 12,
  2: 14,
  3: 16,
  4: 18,
  5: 20,
  6: 24,
  7: 32,
  8: 40,
  9: 48,
  10: 64,
  11: 80,
  12: 96,
  13: 128,
  14: 160,
} as const;

type FontSizeKey = keyof typeof fontSizeScale;

const fontSizeKeys = Object.keys(fontSizeScale) as unknown as FontSizeKey[];

const makeUniformScale = <T extends number | string>(value: T) =>
  fontSizeKeys.reduce(
    (acc, key) => {
      acc[key] = value;
      return acc;
    },
    {} as Record<FontSizeKey, T>,
  );

const headingLineHeightScale: Record<FontSizeKey, number> = {
  1: 16,
  2: 18,
  3: 20,
  4: 22,
  5: 24,
  6: 28,
  7: 36,
  8: 44,
  9: 52,
  10: 68,
  11: 84,
  12: 100,
  13: 134,
  14: 168,
};

const bodyLineHeightScale: Record<FontSizeKey, number> = {
  1: 18,
  2: 20,
  3: 24,
  4: 26,
  5: 28,
  6: 32,
  7: 40,
  8: 52,
  9: 62,
  10: 80,
  11: 100,
  12: 120,
  13: 160,
  14: 200,
};

const monoLineHeightScale: Record<FontSizeKey, number> = {
  1: 16,
  2: 18,
  3: 20,
  4: 22,
  5: 24,
  6: 28,
  7: 36,
  8: 44,
  9: 52,
  10: 68,
  11: 84,
  12: 100,
  13: 134,
  14: 168,
};

// Inter weight scale — Swiss style favours bold/black for headings.
// Map our internal scale onto meaningful Inter weight steps.
const fontWeightScale = {
  1: "400",
  2: "400",
  3: "400",
  4: "500",
  5: "500",
  6: "600",
  7: "700",
  8: "700",
  9: "900",
  10: "900",
  11: "900",
  12: "900",
  13: "900",
  14: "900",
} as const satisfies Record<FontSizeKey, string>;

export const fonts = {
  heading: createFont({
    family: typographyTokens.heading.fontFamily,
    size: fontSizeScale,
    lineHeight: headingLineHeightScale,
    weight: fontWeightScale,
    letterSpacing: makeUniformScale(typographyTokens.heading.letterSpacing),
  }),
  body: createFont({
    family: typographyTokens.body.fontFamily,
    size: fontSizeScale,
    lineHeight: bodyLineHeightScale,
    weight: fontWeightScale,
    letterSpacing: makeUniformScale(typographyTokens.body.letterSpacing),
  }),
  mono: createFont({
    family: typographyTokens.mono.fontFamily,
    size: fontSizeScale,
    lineHeight: monoLineHeightScale,
    weight: fontWeightScale,
    letterSpacing: makeUniformScale(typographyTokens.mono.letterSpacing),
  }),
} as const;

const createBezier = (values: [number, number, number, number]) =>
  typeof Easing?.bezier === "function"
    ? Easing.bezier(...values)
    : (value: number) => value;

const easingMap = {
  easeOut: createBezier([0.17, 0.67, 0.45, 1]),
  easeInOut: createBezier([0.45, 0.05, 0.55, 0.95]),
  easeIn: createBezier([0.55, 0.06, 0.68, 0.19]),
} as const;

// IMPORTANT: this module is evaluated in Node (SSR/build tooling) *and* in the browser.
// Using `typeof document` here can accidentally pick the native animation driver during
// SSR, and the resulting config gets serialized into the web bundle. That produces the
// classic "No animation driver configured" / transitions not running symptoms.
//
// `Platform.OS` is stable across environments for RN-web/Next and is the safest key.
const isWeb = Platform.OS === "web";

// On web (Next.js/React DOM), the RN animation driver isn't fully compatible and
// can miss APIs Tamagui expects (e.g. `usePresence`). Use the CSS animation
// driver instead to avoid runtime crashes.
const rawAnimations = (() => {
  if (isWeb) {
    // CSS animation driver — aligned with motionTokens.duration (ms) and
    // the Swiss spec's "instant, mechanical, snappy" feel.  ease-out
    // gives a quick start with a gentle deceleration.
    return createCssAnimations({
      fast: `ease-out ${motionTokens.duration.fast}ms`,
      base: `ease-out ${motionTokens.duration.base}ms`,
      slow: `ease-out ${motionTokens.duration.slow}ms`,
    });
  }

  const result = createAnimations({
    fast: {
      type: "timing",
      duration: motionTokens.duration.fast,
      easing: easingMap.easeOut,
    },
    base: {
      type: "timing",
      duration: motionTokens.duration.base,
      easing: easingMap.easeInOut,
    },
    slow: {
      type: "timing",
      duration: motionTokens.duration.slow,
      easing: easingMap.easeInOut,
    },
    spring: {
      type: "spring",
      ...motionTokens.spring.base,
    },
  });

  // `createAnimations()` returns a plain object map.
  if (result && typeof result === "object") {
    for (const key of Object.keys(result as Record<string, unknown>)) {
      const value = (result as Record<string, unknown>)[key];
      if (!value || typeof value !== "object") {
        (result as Record<string, unknown>)[key] = {};
      }
    }
  }

  return result;
})();

type TamaguiConfigInput = Parameters<typeof createTamagui>[0];

export const animations = rawAnimations as NonNullable<
  TamaguiConfigInput["animations"]
>;

const colorTokenValues = {
  ...baseColorTokens.color,
} as const;

export const tokens = {
  color: colorTokenValues,
  space: spaceTokens,
  size: sizeTokens,
  radius: radiusTokens,
  zIndex: zIndexTokens,
  motion: motionTokens,
  typography: typographyTokens,
  // Non-Tamagui-native bags (like motion/typography above): border widths and
  // per-theme shadow strings — NOT passed to createTokens (no such categories).
  border: borderTokens,
  elevation: elevationTokens,
  density: densityTokens,
  viz: vizTokens,
  imagery,
} as const;

export const colorTokens = baseColorTokens;
export { borderTokens, elevationTokens, getShadowOverflowPx };
export { densityTokens, resolveDensity, HIT_MIN };
export type { DensityName, DensitySpec } from "./tokens/density";
export { vizTokens, vizSeries };
export type { VizPalette, VizThemeName } from "./tokens/dataviz";
export { imagery };
export type { ImageRatioName } from "./tokens/imagery";
export { monoScale, labelIdioms } from "./tokens/typography";
export type { MonoScaleName, LabelIdiomName } from "./tokens/typography";
export {
  THEME_TOKEN_GROUPS,
  getDarkThemeSnapshot,
  getLightThemeSnapshot,
  getStubThemeSnapshot,
  getThemeTokenKeys,
};

export const media = {
  xs: { maxWidth: 480 },
  sm: { maxWidth: 640 },
  md: { maxWidth: 900 },
  lg: { maxWidth: 1200 },
  xl: { maxWidth: 1440 },
  short: { maxHeight: 780 },
  tall: { minHeight: 780 },
  hoverNone: { hover: "none" as const },
  pointerCoarse: { pointer: "coarse" as const },
  gtXs: { minWidth: 481 },
  gtSm: { minWidth: 641 },
  gtMd: { minWidth: 901 },
} as const;

export const shorthands = createShorthands({
  px: "paddingHorizontal",
  py: "paddingVertical",
  mx: "marginHorizontal",
  my: "marginVertical",
  bg: "backgroundColor",
  br: "borderRadius",
  fd: "flexDirection",
});

// Theme KEYS deliberately avoid the "light"/"dark" prefixes: Tamagui derives a
// theme's color-scheme from the key prefix and emits prefixed themes into a
// `@media (prefers-color-scheme)` :root rule. The app's real base theme is the
// class-applied `stub`, so an OS-dark machine would flash the media-query theme
// on first paint before the `.t_stub` subtree wins. Class-only keys (no
// light/dark prefix) remove that root emission entirely. `stub` stays first so
// Object.keys(themes)[0] is Tamagui's fallback default.
export const themes = {
  stub: stubColorTheme,
  swiss: lightColorTheme,
  ember: darkColorTheme,
} as const;

export type IthasFireThemeName = keyof typeof themes;

export const defaultTheme: IthasFireThemeName = "stub";

// Base config shared by app + storybook. Putting this in one place keeps tokens/themes
// consistent while letting us export separate entrypoints.
const baseTamaguiConfig = {
  tokens: createTokens({
    color: tokens.color,
    space: tokens.space,
    size: tokens.size,
    radius: tokens.radius,
    zIndex: tokens.zIndex,
  }),
  themes,
  fonts,
  shorthands,
  animations,
  media,
} as const;

// App config: what the real web/mobile apps should use.
export const tamaguiConfigApp = createTamagui(baseTamaguiConfig);

// Storybook config: intentionally separate export so Storybook can add its own stubs
// without ever affecting runtime. Today it matches app config, but it’s now isolated.
export const tamaguiConfigStorybook = createTamagui(baseTamaguiConfig);

// Back-compat: keep the old export name pointing to the app config.
export const tamaguiConfig = tamaguiConfigApp;

// Dev-only: helps catch cases where the web build ends up with the stub animation driver
// (which makes AnimatePresence/enterStyle/exitStyle feel like a "pop").
if (process.env.NODE_ENV !== "production") {
  // Avoid noisy logs during SSR.
  if (typeof window !== "undefined" && Platform.OS === "web") {
    const animationKeys = animations ? Object.keys(animations) : [];
    if (animationKeys.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        "[Ithas Fire/Tamagui] No animations configured on web. Slide/enter/exit animations will not run.",
      );
    }
  }
}

export type IthasFireConfig = typeof tamaguiConfigApp;

type TamaguiProviderComponentProps = ComponentProps<typeof TamaguiProvider>;

export type IthasFireProviderProps = Omit<
  TamaguiProviderComponentProps,
  "config" | "defaultTheme"
> & {
  theme?: IthasFireThemeName;
  children?: ReactNode;
};

export const IthasFireProvider = ({
  children,
  theme = defaultTheme,
  ...providerProps
}: IthasFireProviderProps) =>
  createElement(
    TamaguiProvider,
    {
      ...providerProps,
      config: tamaguiConfigApp,
      defaultTheme: theme,
    },
    children,
  );

export * from "./components/index";
