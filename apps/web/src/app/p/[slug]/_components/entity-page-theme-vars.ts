import type { CSSProperties } from "react";
import type { PublicPageData } from "@th/types/repos/entity-pages";
import {
  ENTITY_PAGE_FONT_KEYS,
  normalizeEntityPageFontKey,
  type EntityPageFontKey,
} from "@th/core/use-cases/entity-pages";
import { isSafeThemeColor } from "@th/core/lib/theme-color";
import { stubTheme } from "@th/ui/colors";
import { contrastRatio, themeColorLuminance } from "@/lib/theme-color-luminance";

/**
 * The owner-theme → CSS glue for a public entity page, in a module with NO
 * `"use client"` directive so a SERVER component can call it too. It used to
 * live inside `EntityPageContent.tsx`, which is a client module — importing a
 * function from a client module into a server component hands the server a
 * client REFERENCE, not the function, so the acts page (`/p/[slug]/acts`, a
 * server component that wraps its roster in the same theme) could not reuse
 * it there. Both callers now read from here.
 */

export type EntityPageTheme = PublicPageData["theme"];

const FONT_KEYS = new Set<string>(ENTITY_PAGE_FONT_KEYS);

/**
 * A stored theme colour, trimmed, or null when it is not CSS colour syntax.
 * The write side refuses such values now, but rows saved before that check
 * could hold `url(…)` or `red;position:fixed;…`, which would otherwise land in
 * the inline style of every visitor's page.
 */
function safeThemeColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isSafeThemeColor(trimmed) ? trimmed : null;
}

/** The Stub pair every unthemed root falls back to (cream paper, warm ink). */
const STUB_PAPER = stubTheme.background;
const STUB_INK = stubTheme.color;

const STUB_PAPER_L = themeColorLuminance(STUB_PAPER)!;
const STUB_INK_L = themeColorLuminance(STUB_INK)!;

/**
 * Whether the Stub ink reads better against a colour of luminance `l` than
 * the Stub paper does, by WCAG contrast ratio. The two tie near luminance
 * 0.19, well below the 0.5 midpoint a plain "is it light?" test would use, so
 * mid-tone brand colours (a #3B82F6 blue, a #E2481D orange) take ink.
 */
function inkReadsBetter(l: number): boolean {
  return contrastRatio(l, STUB_INK_L) >= contrastRatio(l, STUB_PAPER_L);
}

/**
 * The owner's background and text as the page will actually paint them.
 *
 * A surface and its ink always travel as a pair. The theme editor saves the
 * two independently, so a page can hold one without the other, and the
 * missing half would otherwise come from a root fallback chosen for a
 * DIFFERENT surface: a dark owner background under the Stub ink, or light
 * owner text on the Stub cream (or on Ember navy, on a freeform page). So a
 * lone colour gets whichever of the Stub ink and paper contrasts with it
 * more (`inkReadsBetter`). A lone colour that cannot be measured (a colour
 * name) is dropped and the root's own fallback pair applies; the theme
 * editor says so when it is set.
 */
function resolveThemePair(theme: EntityPageTheme): {
  bg: string | null;
  text: string | null;
} {
  const bg = safeThemeColor(theme?.colorBg);
  const text = safeThemeColor(theme?.colorText);
  if ((bg && text) || (!bg && !text)) return { bg, text };
  const l = themeColorLuminance((bg ?? text)!);
  if (l == null) return { bg: null, text: null };
  const partner = inkReadsBetter(l) ? STUB_INK : STUB_PAPER;
  return bg ? { bg, text: partner } : { bg: partner, text };
}

/**
 * Build CSS custom properties from the page theme so downstream blocks can
 * reference them (e.g. `var(--th-color-primary)`). A colour that fails the
 * theme colour grammar is left out, so the CSS fallback applies. Background
 * and text are emitted as a pair (`resolveThemePair`).
 */
export function buildEntityPageThemeVars(
  theme: EntityPageTheme,
): CSSProperties {
  if (!theme) return {};

  const vars: Record<string, string> = {};
  const colorPrimary = safeThemeColor(theme.colorPrimary);
  const { bg, text } = resolveThemePair(theme);
  if (colorPrimary) vars["--th-color-primary"] = colorPrimary;
  if (bg) vars["--th-color-bg"] = bg;
  if (text) vars["--th-color-text"] = text;

  return vars as CSSProperties;
}

/** The stored font preset, or Montserrat for anything unset or unknown. */
export function resolveEntityPageFontKey(
  fontKey: string | null | undefined,
): EntityPageFontKey {
  if (!fontKey || !FONT_KEYS.has(fontKey)) return "montserrat";
  return normalizeEntityPageFontKey(fontKey) ?? "montserrat";
}

/**
 * Whether the page's own surface is known to be LIGHT, for components that
 * pick graphic colours by surface (the arrival-area swatches): "light" or
 * null (dark, or not readable here, so the component follows the app theme).
 *
 * `paintsFallback`: the root paints the Stub cream when the owner set no
 * background (`.placeRoot` does; the freeform `.content` stays transparent).
 * The background is the one `buildEntityPageThemeVars` emits (a lone light
 * text colour gets a dark surface). It is light when the Stub ink reads
 * better on it than the paper, the same rule that picked the partner. A
 * background that cannot be measured is left to the app theme.
 */
export function resolveEntityPageSurfaceTone(
  theme: EntityPageTheme,
  paintsFallback: boolean,
): "light" | null {
  const { bg } = resolveThemePair(theme);
  if (!bg) return paintsFallback ? "light" : null;
  const l = themeColorLuminance(bg);
  return l != null && inkReadsBetter(l) ? "light" : null;
}
