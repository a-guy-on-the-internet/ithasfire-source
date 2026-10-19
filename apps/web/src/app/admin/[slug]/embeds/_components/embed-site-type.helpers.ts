// "Your website is: Light · Dark · Custom" — the embed configurator's colour
// question, as pure functions so the mapping is testable without the page.
//
// The answer is DERIVED from the theme params, never stored beside them:
//   no params                      → light
//   exactly Dark's params          → dark
//   anything else                  → custom
// so editing any swatch moves the answer to Custom by itself, and a Light or
// Dark answer can never disagree with the snippet it produced.
//
// Light and Dark write as little as possible. Light writes nothing (the widget
// follows the platform theme, transparent). Dark writes ONE param, a light
// `fontColor`; the embed derives the dark fields ground, muted text, borders
// and a readable link colour from it (embed-host-vars.ts). Everything else
// keeps following the platform, so a later preset still reaches the embed.

import { stubTheme } from "@th/ui/colors";

import type { EmbedThemeEntries } from "@/lib/embed-snippets";
import { deriveHostVars } from "@/app/embed/[embedId]/_components/embed-host-vars";

export type EmbedSiteType = "light" | "dark" | "custom";

/** The four host knobs, in the order the configurator shows them. */
export const THEME_KNOBS = [
  "brandColor",
  "bg",
  "fontColor",
  "accentColor",
] as const;
export type ThemeKnob = (typeof THEME_KNOBS)[number];

/** Knob → param value (6-digit hex, no `#`, upper case). */
export type ThemeOverrides = Partial<Record<ThemeKnob, string>>;

/** A hex from the theme as a param value: `#FDFAF3` → `FDFAF3`. */
const asParam = (hex: string): string => hex.replace("#", "").toUpperCase();

/**
 * Dark's only param: the platform paper (the Stub `onStructure`, the colour
 * the platform prints on ink), as the host text colour.
 */
export const DARK_SITE_OVERRIDES: ThemeOverrides = {
  fontColor: asParam(stubTheme.onStructure),
};

/** The params a template writes. Custom has none of its own. */
export function overridesForSiteType(
  type: Exclude<EmbedSiteType, "custom">,
): ThemeOverrides {
  return type === "dark" ? { ...DARK_SITE_OVERRIDES } : {};
}

/**
 * The colour the embed falls back to for `knob` when its param is absent,
 * given the params that ARE emitted. The accent falls back through the text
 * colour, because that is what the embed does (`STEEL_BLUE` in
 * embed-theme.ts): with only `fontColor` set the structural colour IS the
 * text.
 */
function fallbackFor(
  knob: Exclude<ThemeKnob, "bg">,
  overrides: ThemeOverrides,
  defaults: Record<ThemeKnob, string>,
): string {
  if (knob !== "accentColor") return defaults[knob];
  const font = overrides.fontColor;
  return font && font !== defaults.fontColor ? font : defaults.accentColor;
}

/**
 * The params the snippet and the preview emit, from what the organiser set.
 *
 * A knob equal to what the embed would render without it emits no param, so
 * the embed keeps following the platform (a later preset reaches it). `bg` is
 * different: its default is TRANSPARENT (the host page shows through), not a
 * colour, so ANY colour the organiser picks is a real choice and always
 * emits, even one that happens to equal the picker's starting swatch.
 */
export function themeEntriesFor(
  overrides: ThemeOverrides,
  defaults: Record<ThemeKnob, string>,
): EmbedThemeEntries {
  return THEME_KNOBS.flatMap((key) => {
    const value = overrides[key];
    if (!value) return [];
    if (key !== "bg" && value === fallbackFor(key, overrides, defaults))
      return [];
    return [[key, value] as const];
  });
}

/** The answer the emitted params amount to. */
export function siteTypeForEntries(entries: EmbedThemeEntries): EmbedSiteType {
  if (entries.length === 0) return "light";
  const dark = Object.entries(DARK_SITE_OVERRIDES);
  const matchesDark =
    entries.length === dark.length &&
    dark.every(([key, value]) =>
      entries.some(([k, v]) => k === key && v === value),
    );
  return matchesDark ? "dark" : "custom";
}

/**
 * What the control shows. The only thing not derived from the params is the
 * organiser having PICKED Custom: that is a request to edit, and there is no
 * param that says "custom". It can only ever widen the answer to Custom, so a
 * Light or Dark answer on screen always means the params match exactly.
 */
export function displayedSiteType(
  entries: EmbedThemeEntries,
  customPicked: boolean,
): EmbedSiteType {
  return customPicked ? "custom" : siteTypeForEntries(entries);
}

/**
 * The colour each knob RENDERS with, for the swatches: the organiser's value,
 * else what the embed falls back to (see `fallbackFor`). `bg` is null when
 * unset: the widget is transparent.
 */
export function effectiveKnobColors(
  overrides: ThemeOverrides,
  defaults: Record<ThemeKnob, string>,
): Record<Exclude<ThemeKnob, "bg">, string> & { bg: string | null } {
  return {
    brandColor:
      overrides.brandColor ?? fallbackFor("brandColor", overrides, defaults),
    bg: overrides.bg ?? null,
    fontColor:
      overrides.fontColor ?? fallbackFor("fontColor", overrides, defaults),
    accentColor:
      overrides.accentColor ?? fallbackFor("accentColor", overrides, defaults),
  };
}

/**
 * The colour "Set colour" commits for Background before the picker opens —
 * which is also what stays if the organiser cancels the picker.
 *
 * With no host text colour that is the platform surface (the picker's
 * default). With one, the platform surface can be unreadable: under Dark,
 * cream behind paper text measured about 1:1 and the widget vanished. So it
 * starts from the ground the embed already derives for that text colour
 * (`--hf-ground`, AA-checked in embed-host-vars.ts), i.e. exactly what the
 * fields are painted with today.
 */
export function backgroundSeed(
  overrides: ThemeOverrides,
  defaults: Record<ThemeKnob, string>,
): string {
  const font = overrides.fontColor;
  if (!font || font === defaults.fontColor) return defaults.bg;
  const ground = deriveHostVars({
    brandColor: null,
    bg: null,
    fontColor: font,
    accentColor: null,
  })["--hf-ground"];
  return ground ? asParam(ground) : defaults.bg;
}

/** The configurator's colour state that answer changes move between. */
export type SiteTypeState = {
  overrides: ThemeOverrides;
  customPicked: boolean;
  /**
   * The organiser's last Custom colours, kept for the session (never
   * persisted) so a radio arrow through Light or Dark doesn't wipe them.
   */
  lastCustom: ThemeOverrides | null;
};

/**
 * Choosing an answer. Radios select on arrow keys, so an organiser can pass
 * through Light and Dark on the way somewhere: leaving Custom remembers its
 * colours, and coming back to Custom restores them.
 */
export function chooseSiteType(
  state: SiteTypeState,
  current: EmbedSiteType,
  next: EmbedSiteType,
): SiteTypeState {
  const lastCustom =
    current === "custom" ? { ...state.overrides } : state.lastCustom;
  if (next === "custom") {
    return {
      overrides: lastCustom ? { ...lastCustom } : state.overrides,
      customPicked: true,
      lastCustom,
    };
  }
  return {
    overrides: overridesForSiteType(next),
    customPicked: false,
    lastCustom,
  };
}

/**
 * The preview host to show on ENTERING Custom from a template, so tuning a
 * dark site's colours doesn't drop the preview to the checkerboard. Null
 * leaves the organiser's preview choice alone.
 */
export function previewHostOnEnteringCustom(
  from: EmbedSiteType,
  to: EmbedSiteType,
): "light" | "dark" | null {
  if (to !== "custom" || from === "custom") return null;
  return from;
}
