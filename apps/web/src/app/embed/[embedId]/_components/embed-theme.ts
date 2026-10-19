/**
 * Embed theme tokens — the PLATFORM's light theme, as seen from an embed.
 *
 * Embeds render the platform's light theme: Stub plus whatever preset is
 * active in the platform theme editor. `/embed/*` is appearance-LOCKED to
 * light at the provider level (see `@/lib/route-context`), so the inline `<body>`
 * vars the root layout paints and `ActiveThemeInjector` keeps current are
 * always the light theme's — whatever the viewer toggled on ithasfire.com. A
 * Stub token edit or a newly activated preset therefore reaches every embed
 * with no change here.
 *
 * Every colour below resolves in three steps:
 *
 *   var(--hf-x,  var(--<platform token>,  <Stub value>))
 *        │             │                      │
 *        │             │                      └ SSR / first paint fallback,
 *        │             │                        interpolated from `stubTheme`
 *        │             │                        (never hand-typed)
 *        │             └ the platform theme + active preset (body vars)
 *        └ the organiser's HOST override (`?brandColor=` etc., set on <html>
 *          by `useEmbedThemeOverrides`) — the contract hosts depend on
 *
 * Constants without an `--hf-*` layer never had a host knob; they follow the
 * platform only.
 *
 * The constant NAMES predate the v2 palette (steel blue + #FF5721) and are
 * kept so the ~28 consumers don't churn. Read `STEEL_BLUE` as "the structural
 * colour" and `BRAND_ORANGE` as "the CTA fill".
 */
import type { CSSProperties } from "react";
import { stubTheme, type ThemeTokenKey } from "@th/ui/colors";

// ── Resolution helpers ──────────────────────────────────────────────────────

/** Platform token as a CSS value: `var(--key, <stub value>)`. */
const token = (key: ThemeTokenKey): string =>
  `var(--${key}, ${stubTheme[key]})`;

/** Host override first, then the platform token. */
const hostOr = (hostVar: `--hf-${string}`, key: ThemeTokenKey): string =>
  `var(${hostVar}, ${token(key)})`;

/** A translucent wash of a colour (never concatenate an alpha suffix). */
const wash = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

// ── Brand / CTA ─────────────────────────────────────────────────────────────
//
// The CTA follows the design system's fill LADDER, not the accent itself:
// `brandSecondary` (#E2481D on Stub) has no AA small-text foreground in either
// polarity (white 4.06:1, ink 4.38:1). A label rests on `brandSecondaryHover`
// with `onBrandSecondary` (Stub: white on #B93312 = 5.92:1); hover climbs to
// `brandSecondaryStrong`. A host `brandColor` override replaces the fill and
// `useEmbedThemeOverrides` picks the label by luminance (`--hf-on-brand`).

/** CTA fill — the ladder's rest rung, or the host's brand colour. */
export const BRAND_ORANGE = hostOr("--hf-brand", "brandSecondaryHover");
/** CTA hover fill — the ladder's next rung, or the host brand darkened. */
export const BRAND_ORANGE_HOVER = hostOr(
  "--hf-brand-hover",
  "brandSecondaryStrong",
);
/**
 * The label on `BRAND_ORANGE`. NOT `TEXT`: a host's light `fontColor` must not
 * land on the fill. `--hf-on-brand` is the luminance-picked label for a host
 * brand colour; without one it is the ladder's own foreground.
 */
export const TEXT_ON_BRAND = hostOr("--hf-on-brand", "onBrandSecondary");
/**
 * The brand hue as small TEXT — the "01." / "02." section numerals. These are
 * real 13px text, so they take `accentText` (Stub #A8300F, 5.98:1 on cream),
 * not `accent` (#E2481D, 3.57:1 — fails as a label). A host `brandColor`
 * still wins, as it always has for these numerals.
 *
 * With `fontColor` set, `--hf-link` outranks both: it is that same hue (the
 * host brand, or the platform accent) moved toward the text colour until it
 * clears AA on the ground the text implies (embed-host-vars.ts). Without it a
 * dark website got rust numerals at about 2:1.
 */
export const BRAND_TEXT = `var(--hf-link, ${hostOr("--hf-brand", "accentText")})`;

// ── Structure (the old "steel blue") ────────────────────────────────────────

/**
 * Structural colour — section labels, back buttons, selected fills, links.
 * On Stub `structure` IS the ink, so a host `fontColor` carries it too when no
 * `accentColor` is set: a dark website that sets white text must not keep ink
 * labels (measured: "SELECT TICKETS" and the selected tier vanished on
 * `?bg=111111&fontColor=FFFFFF`). Same rule the calendar bridge applies.
 */
export const STEEL_BLUE = `var(--hf-accent, var(--hf-text, ${token("structure")}))`;
/**
 * Selected / active wash of the structural colour — of the host text colour
 * when only `fontColor` is set (an ink wash is invisible on a dark host),
 * matching `STEEL_BLUE`'s own fallback chain.
 */
export const STEEL_BLUE_SOFT = `var(--hf-accent-soft, ${wash(`var(--hf-text, ${token("structure")})`, 8)})`;

// ── Text ────────────────────────────────────────────────────────────────────

/** Primary text. */
export const TEXT = hostOr("--hf-text", "color");
/** Secondary / muted text. */
export const TEXT_MUTED = hostOr("--hf-text-muted", "colorMuted");
/**
 * Caption text. The platform has no tier below `colorMuted` that clears AA
 * (the old #A0A0A0 was 2.6:1 on a white host), so captions share the muted rung.
 */
export const TEXT_CAPTION = TEXT_MUTED;
/**
 * The label on a `STEEL_BLUE` fill (selected ticket chip, active view toggle,
 * selected seat, active series date). A host `accentColor` repaints that fill,
 * so the label rides `--hf-on-accent` — ink or white by the host colour's
 * luminance (useEmbedThemeOverrides), exactly like `--hf-on-brand` on the CTA.
 * With only `fontColor` set the fill is the host text colour (`STEEL_BLUE`
 * above), so the label is its companion `--hf-on-text`.
 */
export const TEXT_INVERTED = `var(--hf-on-accent, var(--hf-on-text, ${token("onStructure")}))`;

// ── Surfaces ────────────────────────────────────────────────────────────────

/** Primary surface — transparent so the host page shows through (embed contract). */
export const SURFACE = "transparent";
/*
 * The three opaque grounds below all carry text, so each takes the HOST
 * GROUND first (`--hf-ground`, embed-host-vars.ts): the host `bg`, or — with
 * only `fontColor` set — the text colour's own companion. Without it, a
 * dark-site host that set white text got white text on cream wells.
 */
/** Opaque surface — for elements that MUST obscure the background (sheets, sticky bars). */
export const SURFACE_OPAQUE = hostOr("--hf-ground", "surface");
/** Muted surface — alternating rows, sidebar tints, the order summary. */
export const SURFACE_MUTED = hostOr("--hf-ground-muted", "surfaceMuted");
/** Input well — the platform's form-field ground (globals.css input contract). */
export const SURFACE_INPUT = hostOr("--hf-ground", "background");
/** Modal backdrop behind a bottom sheet — the platform overlay. */
export const OVERLAY = token("overlay");

// ── Borders ─────────────────────────────────────────────────────────────────

/**
 * Standard divider / field border — the platform's soft hairline (ink at 30%),
 * or the host text colour at 30% when it set `fontColor` (`--hf-border`).
 */
export const BORDER = hostOr("--hf-border", "borderColorSoft");
/** Subtle border between related items. Same rung: the platform has one soft tier. */
export const BORDER_SUBTLE = BORDER;

// ── Status ──────────────────────────────────────────────────────────────────

export const SUCCESS = token("success");
export const SUCCESS_BG = wash(SUCCESS, 10);
export const DANGER = token("danger");
export const DANGER_BG = wash(DANGER, 8);
/** Warning TEXT/icon colour — Stub's amber is darkened to clear AA as text. */
export const WARNING = token("warning");
export const WARNING_BG = wash(WARNING, 10);

// ── Host-override knobs ─────────────────────────────────────────────────────

/**
 * The platform token each host knob replaces BY DEFAULT — i.e. what an
 * embed shows when the organiser leaves that knob alone. The admin
 * configurator seeds its colour pickers from these, resolved against the live
 * light theme, so a picker never shows a colour the embed wouldn't render.
 *
 * `bg` is the exception: an untouched embed is TRANSPARENT (the host page
 * shows through — `SURFACE`). Its entry is only the picker's STARTING colour
 * (the platform surface, what opaque sheets and bars use); the configurator
 * shows the knob as "Transparent" until a colour is chosen, and a chosen
 * colour always emits its param.
 */
export const EMBED_KNOB_DEFAULT_TOKENS = {
  brandColor: "brandSecondaryHover",
  bg: "surface",
  fontColor: "color",
  accentColor: "structure",
} as const satisfies Record<keyof EmbedThemeOverrides, ThemeTokenKey>;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * Each knob's default as the URL param format (6-char hex, no `#`, upper
 * case), read from a resolved light theme (Stub + the active preset). A
 * preset value that isn't a plain 6-digit hex (rgba, a named colour) can't
 * seed an `<input type="color">`, so that knob falls back to Stub.
 */
export function embedKnobDefaults(
  theme: Partial<Record<string, string>>,
): Record<keyof EmbedThemeOverrides, string> {
  const out = {} as Record<keyof EmbedThemeOverrides, string>;
  for (const [knob, key] of Object.entries(EMBED_KNOB_DEFAULT_TOKENS) as Array<
    [keyof EmbedThemeOverrides, ThemeTokenKey]
  >) {
    const live = theme[key];
    const hex = live && HEX6.test(live) ? live : stubTheme[key];
    out[knob] = hex.slice(1).toUpperCase();
  }
  return out;
}

// ── Host-override bridge for SHARED components ──────────────────────────────

/** The four host knobs `useEmbedThemeOverrides` resolves. Null = not set. */
export type EmbedThemeOverrides = {
  brandColor: string | null;
  bg: string | null;
  fontColor: string | null;
  accentColor: string | null;
};

/**
 * Route the host `--hf-*` overrides onto the PLATFORM token names that shared
 * app components (EventGridCard, EventDetail, CheckoutStepper, the address
 * dropdown) paint with, for the subtree this style lands on — the ticket
 * widget's screen root.
 *
 * Only ACTIVE overrides are emitted. With none set the wrapper declares
 * nothing, so every shared component inherits the platform theme straight
 * from `<body>` — this is not a palette, just the seam for host knobs. (An
 * unconditional `--color: var(--hf-text, var(--color))` is impossible: it
 * references itself, which CSS resolves as invalid.)
 *
 * Knob by knob, against the var maps this replaced (EMBED_EVENT_CONTENT_VARS
 * on the grid + EventDetail, EMBED_STEPPER_VARS on the stepper):
 * - fontColor → `--color`, `--foreground`, `--colorMuted` (+ its `--muted`
 *   alias): same vars as before. Also `--structure` + `--onStructure`
 *   (`--hf-on-text`), as a unit: on Stub the structure IS the ink, and a
 *   white-text host otherwise kept ink structural labels on its dark page.
 *   The other `$onStructure` fills travel with them — `--surfaceStrong` (tag
 *   chips) and `--structurePress` (secondary button press) — since bridging
 *   the label alone printed ink on their ink fills.
 *   And `--borderColorSoft` (`--hf-border`, the text colour at 30%): the
 *   platform hairline is ink at 30%, invisible on a dark page. And
 *   `--accentText` (`--hf-link`): link text re-derived to clear AA on the
 *   ground the text colour implies.
 * - bg OR fontColor → the ground pair: `--background`, `--surface` →
 *   `--hf-ground`; `--surfaceMuted`, `--surfaceRaised`, `--mutedSurface`,
 *   `--backgroundHover`, `--backgroundFocus` → `--hf-ground-muted`. With `bg`
 *   the ground is the host colour, as before; with only `fontColor` it is the
 *   text colour's companion — without this, EventDetail's "Get directions"
 *   well and the tier-card panel put white host text on cream.
 * - brandColor → the CTA fill LADDER (`--brandSecondaryHover` rest,
 *   `--brandSecondaryStrong`/`--brandSecondaryPress` hover/press) with its
 *   luminance-picked label `--onBrandSecondary`. NEW for these components:
 *   under the old `<Theme name="swiss">` wrapper the cards' price chip stayed
 *   #FF5721 whatever the host set, while the widget's own CTAs followed the
 *   brand. `--brandSecondary` / `--accent` (graphics: the poster rule on the
 *   ink scrim, index bars) are deliberately NOT bridged — a dark host brand
 *   would vanish against the scrim.
 * - accentColor → nothing here. The old stepper map set `--accent`, but
 *   CheckoutStepper never reads it, and the grid/EventDetail sat on the swiss
 *   theme's own accent. Bridging it widget-wide recoloured the platform's
 *   flame accents with the host's structural colour. The tier card, which did
 *   read it, bridges it itself (memberships page).
 */
export function embedThemeBridgeStyle(o: EmbedThemeOverrides): CSSProperties {
  const style: Record<string, string> = {};
  if (o.fontColor) {
    style["--color"] = "var(--hf-text)";
    // Legacy globals.css alias: hairlines and inverted panels build on it.
    style["--foreground"] = "var(--hf-text)";
    style["--colorMuted"] = "var(--hf-text-muted)";
    style["--muted"] = "var(--hf-text-muted)";
    style["--structure"] = "var(--hf-text)";
    // Every fill that prints an `$onStructure` label rides the same text
    // colour, or the label turns to ink on an ink fill (1:1): the tag chips
    // (`$surfaceStrong`) and the secondary button's press rung
    // (`$structurePress`, "Add to calendar").
    style["--surfaceStrong"] = "var(--hf-text)";
    style["--structurePress"] = "var(--hf-text)";
    style["--onStructure"] = "var(--hf-on-text)";
    style["--borderColorSoft"] = "var(--hf-border)";
    // The hard Swiss rule (ticket rows, the share trigger) IS the ink on
    // Stub, so it rides the text colour like `--structure`; an ink rule on a
    // dark page measured 1.1:1.
    style["--borderColor"] = "var(--hf-text)";
    // Link / accent TEXT (venue and location links, "+N more"): the platform
    // rung is picked for cream and reads at ~2:1 on a dark page. `--hf-link`
    // is the brand hue re-derived against the text colour's ground.
    style["--accentText"] = "var(--hf-link)";
  }
  if (o.bg || o.fontColor) {
    // The platform's text-bearing grounds follow the HOST GROUND (the host
    // `bg`, or the text colour's companion when only `fontColor` is set), so
    // a panel and the text on it always move together. Opaque on purpose:
    // completed stepper chips paint `var(--color)` as a fill and print their
    // glyph in `var(--background)`.
    style["--background"] = "var(--hf-ground)";
    style["--surface"] = "var(--hf-ground)";
    style["--surfaceMuted"] = "var(--hf-ground-muted)";
    style["--surfaceRaised"] = "var(--hf-ground-muted)";
    style["--mutedSurface"] = "var(--hf-ground-muted)";
    style["--backgroundHover"] = "var(--hf-ground-muted)";
    style["--backgroundFocus"] = "var(--hf-ground-muted)";
  }
  if (o.brandColor) {
    style["--brandSecondaryHover"] = "var(--hf-brand)";
    style["--brandSecondaryStrong"] = "var(--hf-brand-hover)";
    style["--brandSecondaryPress"] = "var(--hf-brand-hover)";
    style["--onBrandSecondary"] = "var(--hf-on-brand)";
  }
  return style as CSSProperties;
}

// ── Layout helpers ──────────────────────────────────────────────────────────

/** Uppercase section label — Swiss typographic treatment. */
export const sectionLabelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: STEEL_BLUE,
  margin: 0,
};

/** Section number prefix — accent ornament, monospace. */
export const sectionNumStyle: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: "0.14em",
  color: BRAND_TEXT,
  fontVariantNumeric: "tabular-nums",
  textTransform: "uppercase",
};

/** Top bar / header row shared style. */
export const headerBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  borderBottom: `2px solid ${BORDER}`,
  background: SURFACE,
  padding: "10px 16px",
};

/** Back button — structural colour, rectangular, no border. */
export const backButtonStyle: CSSProperties = {
  display: "flex",
  height: 32,
  width: 32,
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
  color: STEEL_BLUE,
  border: "none",
  background: "none",
  cursor: "pointer",
};

/** Page title in header bar. */
export const headerTitleStyle: CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: TEXT,
  margin: 0,
};

/** Primary CTA button — the fill ladder's rest rung, rectangular, bold uppercase. */
export const primaryButtonStyle: CSSProperties = {
  display: "flex",
  width: "100%",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  borderRadius: 0,
  background: BRAND_ORANGE,
  padding: "12px 24px",
  // ≥44px tap target on touch surfaces
  minHeight: 44,
  boxSizing: "border-box",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: TEXT_ON_BRAND,
  border: "none",
  cursor: "pointer",
};

/** Primary CTA disabled state overlay. */
export const primaryButtonDisabledStyle: CSSProperties = {
  opacity: 0.4,
  pointerEvents: "none",
};

/** Secondary button — structural border + text, rectangular. */
export const secondaryButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  borderRadius: 0,
  border: `2px solid ${STEEL_BLUE}`,
  background: SURFACE_OPAQUE,
  padding: "8px 16px",
  fontSize: 14,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: STEEL_BLUE,
  cursor: "pointer",
};

/** Trust badge text style. */
export const trustBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: STEEL_BLUE,
};

/** Shared input field style — the platform input well.
 *  16px font is the iOS-Safari zoom floor (focusing a <input> below 16px
 *  zooms the whole page); minHeight 44 is the mobile tap-target floor.
 *  width 100% + minWidth 0 (mirroring the main checkout's inputStyle) keep
 *  `<select>`s from sizing to their widest option — without them the
 *  STATE/COUNTRY selects rendered at their intrinsic ~344px width inside the
 *  1fr grid tracks and ran ~195px past a 390px viewport. */
export const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  borderRadius: 0,
  border: `1px solid ${BORDER}`,
  background: SURFACE_INPUT,
  padding: "10px 14px",
  minHeight: 44,
  boxSizing: "border-box",
  fontSize: 16,
  color: TEXT,
  transition: "border-color 0.15s",
};

/** Input label — uppercase, muted, compact. */
export const inputLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: TEXT_MUTED,
};

// ── Resolved colours for non-CSS consumers (Stripe Elements) ────────────────

/**
 * Resolve an embed colour to a CONCRETE value. Stripe Elements render in
 * Stripe-hosted iframes where `var(...)` never resolves, so the appearance
 * API needs real colours derived from the SAME chain the rest of the embed
 * uses: the host override on `<html>` (useEmbedThemeOverrides), else the
 * platform token on `<body>` (root layout + ActiveThemeInjector), else Stub.
 */
function resolveEmbedColor(
  hostVar: `--hf-${string}` | null,
  key: ThemeTokenKey,
): string {
  if (typeof window === "undefined") return stubTheme[key];
  const read = (el: Element, name: string) =>
    getComputedStyle(el).getPropertyValue(name).trim();
  return (
    (hostVar ? read(document.documentElement, hostVar) : "") ||
    read(document.body, `--${key}`) ||
    stubTheme[key]
  );
}

export type EmbedStripeColors = {
  brand: string;
  /**
   * Stripe's `colorPrimary`: it paints the fill accents AND accent TEXT (the
   * selected payment tab's label, "Secure, fast checkout with Link"). With a
   * host text colour set that text sits on the dark ground, so it takes the
   * derived link colour; otherwise it stays the brand, exactly as before.
   */
  primary: string;
  text: string;
  textMuted: string;
  accent: string;
  inputBackground: string;
  border: string;
  danger: string;
};

/** Snapshot the resolved theme colours for the Stripe appearance config. */
export function getResolvedEmbedStripeColors(): EmbedStripeColors {
  return {
    brand: resolveEmbedColor("--hf-brand", "brandSecondaryHover"),
    primary:
      (typeof window === "undefined"
        ? ""
        : getComputedStyle(document.documentElement)
            .getPropertyValue("--hf-link")
            .trim()) ||
      resolveEmbedColor("--hf-brand", "brandSecondaryHover"),
    text: resolveEmbedColor("--hf-text", "color"),
    textMuted: resolveEmbedColor("--hf-text-muted", "colorMuted"),
    accent: resolveEmbedColor("--hf-accent", "structure"),
    // Through the host ground first, exactly like the embed's own inputs
    // (`SURFACE_INPUT`): a host that set `fontColor` — with or without `bg` —
    // must not get its text colour on a cream Stripe well.
    inputBackground: resolveEmbedColor("--hf-ground", "background"),
    border: resolveEmbedColor("--hf-border", "borderColorSoft"),
    danger: resolveEmbedColor(null, "danger"),
  };
}
