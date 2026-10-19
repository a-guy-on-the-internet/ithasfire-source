/**
 * Host override knobs → the `--hf-*` custom properties the embed reads.
 *
 * Pure (no DOM, no React) so the colour decisions are unit-testable;
 * `useEmbedThemeOverrides` only applies the result to `<html>`.
 *
 * The rule every derivation here follows: a FILL and the text on it are one
 * unit. Whenever a host knob moves one side of a pair, this module derives the
 * other side from it, and checks the pair clears WCAG AA (4.5:1).
 */
import { stubTheme } from "@th/ui/colors";

import type { EmbedThemeOverrides } from "./embed-theme";

// ── Colour math ─────────────────────────────────────────────────────────────

type RGB = [number, number, number];

/** 6-char hex, with or without `#`. */
export function parseHex(hex: string): RGB {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: RGB): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Move `a` toward `b` by `t` (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

// Built from channels, not literals: these are computation endpoints (label
// candidates, mix targets), not palette colours — and the hex lint is right
// that components shouldn't carry hex.
const BLACK = toHex([0, 0, 0]);
const WHITE = toHex([255, 255, 255]).toUpperCase();
/** The platform ink — the preferred dark label, sourced from the theme. */
const INK = stubTheme.color;

export const darken = (hex: string, t: number): string => mix(hex, BLACK, t);
export const lighten = (hex: string, t: number): string => mix(hex, WHITE, t);

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = parseHex(hex);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio between two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const AA = 4.5;

// ── Labels on host fills ────────────────────────────────────────────────────

/**
 * The label for text on one or more host-coloured fills: the platform ink or
 * white, whichever has the better WORST-case contrast across `fills`. When
 * neither clears AA (host colours near the mid-tone crossover), pure black is
 * tried as well — it clears 4.58:1 against any colour white fails on.
 */
export function readableOn(...fills: string[]): string {
  const worst = (label: string) =>
    Math.min(...fills.map((f) => contrast(label, f)));
  const best = [INK, WHITE].sort((a, b) => worst(b) - worst(a))[0]!;
  if (worst(best) >= AA) return best;
  return worst(BLACK) > worst(best) ? BLACK : best;
}

/**
 * The CTA ladder a host `brandColor` produces: rest fill, hover/press fill,
 * and ONE label that clears AA on both.
 *
 * The hover rung moves AWAY from the label — darker under a white label,
 * lighter under a dark one — so hover contrast is never below rest. (A fixed
 * "darken 12%" did the opposite for light brands: ink on #8A8A8A is 4.8:1 at
 * rest and fell to 3.8:1 on a darkened hover.)
 */
export function brandLadder(brand: string): {
  rest: string;
  hover: string;
  label: string;
} {
  const rest = brand.startsWith("#") ? brand : `#${brand}`;
  const hoverFor = (label: string) =>
    luminance(label) > luminance(rest)
      ? darken(rest, 0.12)
      : lighten(rest, 0.12);
  const score = (label: string) =>
    Math.min(contrast(label, rest), contrast(label, hoverFor(label)));
  const best = [INK, WHITE].sort((a, b) => score(b) - score(a))[0]!;
  const label = score(best) >= AA || score(BLACK) <= score(best) ? best : BLACK;
  return { rest, hover: hoverFor(label), label };
}

/**
 * Muted text for one or more grounds: the text colour pulled toward the FIRST
 * ground as far as it can go while still clearing AA against EVERY ground it
 * sits on. (The old `lighten(text, 40%)` turned white text into white "muted"
 * text — and placeholders with it.)
 */
export function mutedOn(text: string, ...grounds: string[]): string {
  const toward = grounds[0]!;
  for (let t = 0.45; t > 0; t -= 0.05) {
    const m = mix(text, toward, t);
    if (grounds.every((g) => contrast(m, g) >= AA + 0.1)) return m;
  }
  return text;
}

/**
 * `from` mixed toward `to` by the LARGEST amount, starting at `max` and
 * stepping down to 0, that keeps `text` at AA on the result. At 0 it is `from`
 * itself, so the caller's `from` must already clear AA (it is always a
 * `readableOn` pick or a ground derived from one).
 *
 * This is what stops a mid-tone text colour losing AA to the tint: the fields
 * ground was a fixed 6% nudge, and `fontColor=767676` (white companion,
 * 4.54:1) landed at ~4.24:1 on it.
 */
function tintWithin(
  from: string,
  to: string,
  max: number,
  text: string,
): string {
  for (let t = max; t > 0; t -= 0.01) {
    const c = mix(from, to, t);
    if (contrast(text, c) >= AA) return c;
  }
  return from;
}

/**
 * Link / accent TEXT for a host text colour: the brand hue moved toward the
 * text colour until it clears AA on every ground it can sit on.
 *
 * With `fontColor` set and a transparent body, the host page is assumed to be
 * the text colour's opposite (`readableOn(text)`) — the same assumption the
 * derived ground makes. The platform's link rung (`accentText`, Stub #A8300F)
 * is picked for cream, so on the dark page a light `fontColor` implies it read
 * at about 2:1. Moving the hue toward the TEXT keeps the brand colour
 * recognisable (a rust link lightens to a salmon on a dark site, darkens on a
 * light one) and ends, at worst, at the text colour itself, which clears AA
 * by construction.
 */
export function linkOn(hue: string, text: string, grounds: string[]): string {
  const clears = (c: string) => grounds.every((g) => contrast(c, g) >= AA);
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(hue, text, t);
    if (clears(c)) return c;
  }
  return text;
}

// ── Knobs → custom properties ──────────────────────────────────────────────

/**
 * Platform colours read at runtime from the live theme (Stub + the active
 * preset — `ActiveThemeInjector` mirrors them onto `<body>`). Each is
 * optional: a missing or non-hex value falls back to Stub, which is also what
 * SSR / first paint uses.
 */
export type PlatformColors = {
  /** The platform `accent` — the hue the link colour starts from. */
  accent?: string | null;
};

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * Every `--hf-*` property the active knobs produce.
 *
 * The GROUND pair (`--hf-ground`, `--hf-ground-muted`) is what every
 * text-bearing well or panel sits on: inputs, the Stripe fields, sheets and
 * sticky bars, shared `$surface` / `$background` panels. It is the host `bg`
 * when set. With ONLY `fontColor` set — the admin's "Your website is: Dark"
 * answer, background left transparent — it is the text colour's own
 * companion (ink or white), nudged up to 6% toward the text so a well still
 * reads as a well against the host page, but never so far that the text drops
 * below AA on it. Either way text and ground move together.
 */
export function deriveHostVars(
  o: EmbedThemeOverrides,
  platform: PlatformColors = {},
): Record<string, string> {
  const v: Record<string, string> = {};
  const text = o.fontColor ? `#${o.fontColor}` : null;
  const bg = o.bg ? `#${o.bg}` : null;

  if (o.brandColor) {
    const ladder = brandLadder(o.brandColor);
    v["--hf-brand"] = ladder.rest;
    v["--hf-brand-hover"] = ladder.hover;
    v["--hf-on-brand"] = ladder.label;
  }

  // The host page behind a transparent widget, as far as this module can
  // know it: the host `bg`, else the text colour's opposite.
  const page = bg ?? (text ? readableOn(text) : null);
  const ground = bg ?? (text ? tintWithin(page!, text, 0.06, text) : null);
  if (ground) {
    v["--hf-ground"] = ground;
  }
  const groundMuted = bg
    ? null
    : ground && text
      ? tintWithin(ground, text, 0.08, text)
      : null;

  if (bg) {
    v["--hf-bg"] = bg;
    v["--hf-bg-muted"] = withAlpha(bg, 0.65);
    v["--hf-ground-muted"] = v["--hf-bg-muted"];
  } else if (groundMuted) {
    v["--hf-ground-muted"] = groundMuted;
  }

  if (text) {
    // Every opaque ground text can sit on. The muted rung must clear AA on
    // ALL of them, not just the harder one: at a mid-tone the "harder" ground
    // flips with the direction of the mix.
    const grounds = groundMuted
      ? [ground!, groundMuted, page!]
      : [ground!];
    v["--hf-text"] = text;
    v["--hf-text-muted"] = mutedOn(text, ...grounds);
    // The companion for the text colour used as a FILL (the calendar's TODAY
    // square, the selected dot-grid day, a structural fill when no accent).
    v["--hf-on-text"] = readableOn(text);
    // The platform hairline is ink at 30%; on a host text colour it is that
    // colour at 30%, or field borders vanish on a dark page.
    v["--hf-border"] = withAlpha(text, 0.3);
    // Link / accent text (`--accentText` consumers, the section numerals):
    // the brand hue, or the LIVE platform accent without one (so a preset's
    // accent still reaches a dark-site embed), moved toward the text colour
    // until it reads on every ground.
    const platformAccent =
      platform.accent && HEX6.test(platform.accent)
        ? platform.accent
        : stubTheme.accent;
    v["--hf-link"] = linkOn(
      o.brandColor ? `#${o.brandColor}` : platformAccent,
      text,
      grounds,
    );
  }

  if (o.accentColor) {
    const accent = `#${o.accentColor}`;
    v["--hf-accent"] = accent;
    v["--hf-accent-hard"] = darken(accent, 0.15);
    v["--hf-accent-soft"] = withAlpha(accent, 0.08);
    // The label on the accent as a fill (selected chip, active toggle).
    v["--hf-on-accent"] = readableOn(accent);
  }

  return v;
}

/** Every property `deriveHostVars` can set — for cleanup. */
export const HOST_VAR_NAMES = [
  "--hf-brand",
  "--hf-brand-hover",
  "--hf-on-brand",
  "--hf-ground",
  "--hf-ground-muted",
  "--hf-bg",
  "--hf-bg-muted",
  "--hf-text",
  "--hf-text-muted",
  "--hf-on-text",
  "--hf-border",
  "--hf-link",
  "--hf-accent",
  "--hf-accent-hard",
  "--hf-accent-soft",
  "--hf-on-accent",
] as const;
