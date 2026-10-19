"use client";

import { useEffect, useMemo } from "react";
import { getDarkThemeSnapshot, getStubThemeSnapshot } from "@th/ui";
import { updateTheme } from "@tamagui/theme";
import { trpc } from "@/trpc";
import { useAppTheme } from "@/components/theme/AppThemeProvider";
import { mergeActivePreset } from "@/lib/theme-preset";

/**
 * Applies the active theme preset by mutating Tamagui's in-memory "stub"
 * theme (the app's base theme). Runs once at app boot and whenever the active
 * preset changes.
 *
 * ## How it works
 *
 * Tamagui components read colours through `useTheme()`, which resolves from
 * an internal React-context store — **not** from DOM CSS custom properties.
 * Setting `--background` on `<body>` or `<html>` only affects plain-CSS
 * consumers (globals.css); every Tamagui `<Button>`,
 * `<Card>`, navbar, event card, etc. is invisible to that approach.
 *
 * `updateTheme({ name: "stub", theme })` from `@tamagui/theme`:
 *   1. Merges the partial theme into the in-memory config.
 *   2. Re-generates the `.t_stub` CSS rules with the new values.
 *   3. Calls `forceUpdateThemes()` which triggers `useSyncExternalStore`
 *      listeners so every themed component re-renders.
 *
 * We also mirror the overrides as inline CSS custom properties on `<body>`
 * for the handful of plain-CSS consumers (globals.css `--background`, etc.).
 *
 * ### Reset
 * When the "default" preset is activated (empty tokens) or no preset is
 * active, we restore the original stub-theme values via the same mechanism.
 *
 * Render this component once near the top of the tree (e.g. in the root
 * layout, inside `<TrpcProvider>`).
 */
export const ActiveThemeInjector = () => {
  const { data } = trpc.platform.getActiveTheme.useQuery(undefined, {
    staleTime: 60_000,
    // Avoid blocking UI — theme is progressive enhancement
    retry: false,
  });

  // The active BASE theme depends on the user's light/dark mode. Its snapshot is
  // both what we reset presets to AND what we mirror onto <body> — mirroring the
  // *stub* snapshot regardless of mode is exactly what used to pin the app to
  // light (the inline body vars override Tamagui's ember theme class). Deriving
  // it from `mode` is what makes dark mode paint end-to-end.
  const { appearance, mode } = useAppTheme();
  const base = useMemo(
    () => (mode === "dark" ? getDarkThemeSnapshot() : getStubThemeSnapshot()),
    [mode],
  );

  useEffect(() => {
    // NB: do NOT bail when `data` is absent. The base theme must be applied on
    // every mode change regardless of the preset query — otherwise toggling to
    // dark before (or without) the preset query resolving would switch Tamagui
    // to ember while leaving the plain-CSS body vars on stub. Presets are an
    // OPTIONAL overlay on top of the active base.
    //
    // Merge the active preset (if it has overrides) over the active base
    // theme; with no preset, the base theme's own values. Shared with the
    // admin embed configurator via lib/theme-preset.ts.
    const { tokens: merged, presetTokens } = mergeActivePreset(base, data);

    // ── 1. Mutate Tamagui's in-memory "stub" theme ────────────────────
    // This updates the React-context store, re-generates .t_stub CSS rules,
    // and forces all themed components to re-render.
    try {
      updateTheme({ name: appearance, theme: merged });
    } catch {
      // updateTheme can throw in SSR or if config isn't ready yet.
      // Fall through to the CSS-var fallback below.
    }

    // ── 2. Mirror as CSS custom properties on <body> ────────────────────
    // Plain-CSS consumers (globals.css, event-
    // content.css) read `var(--background)` etc. from the cascade, so we
    // still need these.
    const body = document.body;
    for (const [key, value] of Object.entries(merged)) {
      body.style.setProperty(`--${key}`, value);
    }
    // `--foreground` is a legacy globals.css alias, not a theme key, so the
    // loop above never touches it — but SSR inlines it on <body> (see
    // themeCssVarsForMode), so without this a client-side light↔dark toggle
    // would leave it pinned to the ORIGINAL mode's ink while every other var
    // flips. Keep it in lockstep with the theme's `color`, like SSR does.
    body.style.setProperty("--foreground", merged.color ?? base.color);

    // --th-font-* for globals.css font stack fallbacks.
    // NOTE: `fontMono` is a retired preset key — nothing consumes --th-font-mono
    // any more (Montserrat is the only brand font; code uses the system stack).
    if (presetTokens?.fontBody) {
      body.style.setProperty("--th-font-body", presetTokens.fontBody);
    }

    return () => {
      // On unmount / re-run, clear CSS vars. Tamagui's in-memory state
      // persists until the next effect run applies new values.
      clearInlineCSSVars(body, base);
    };
  }, [data, appearance, base]);

  // This component renders nothing
  return null;
};

ActiveThemeInjector.displayName = "ActiveThemeInjector";

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Remove all inline CSS custom properties previously set by this injector
 * on the given element.
 */
function clearInlineCSSVars(el: HTMLElement, base: Record<string, string>) {
  const themeKeys = new Set(Object.keys(base));
  const style = el.style;
  const toRemove: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style[i]!;
    if (prop.startsWith("--") && themeKeys.has(prop.slice(2))) {
      toRemove.push(prop);
    }
    if (prop === "--foreground") {
      toRemove.push(prop);
    }
    if (prop.startsWith("--th-font-")) {
      toRemove.push(prop);
    }
  }
  for (const prop of toRemove) {
    style.removeProperty(prop);
  }
}
