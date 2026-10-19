"use client";

import { useThemeName } from "tamagui";

/**
 * True when the active base theme is the dark "Ember" palette.
 *
 * The Tamagui theme KEYS are `stub` / `swiss` / `ember` (see
 * `packages/ui/src/ui/tamagui/index.ts`) — deliberately WITHOUT a
 * `light`/`dark` prefix so Tamagui doesn't emit a `prefers-color-scheme`
 * root theme. So the dark theme cannot be detected by a `"dark"` prefix;
 * it must be matched by its exact key, `ember`. `stub` and `swiss` are the
 * light themes.
 */
export function useIsDarkTheme(): boolean {
  return useThemeName() === "ember";
}
