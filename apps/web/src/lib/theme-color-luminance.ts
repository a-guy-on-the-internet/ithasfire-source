/**
 * WCAG relative luminance for a colour in the entity-page theme grammar
 * (`@th/core/lib/theme-color`): hex in all four lengths, and `rgb()` /
 * `rgba()` / `hsl()` / `hsla()` in comma or space syntax. Alpha is ignored:
 * the owner picked the colour, and the page paints it over its own root.
 *
 * Colour NAMES are not measured (no keyword table here), and neither is any
 * value outside that closed grammar: the result is null, never a guess.
 *
 * LEAF MODULE: no imports, so the public page and the theme editor can both
 * read it without pulling anything else into the client bundle.
 */

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FN = /^(rgba?|hsla?)\(([\d.%\s,/]|deg)+\)$/i;

/** One linear-light sRGB channel from a 0..1 gamma value. */
function linear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function fromRgb(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A plain decimal (no exponent, no sign), or NaN. */
function num(token: string): number {
  return /^(\d+\.?\d*|\.\d+)$/.test(token) ? Number(token) : Number.NaN;
}

/** An rgb() channel: `0..255` or `0%..100%`, as 0..1. */
function rgbChannel(token: string): number {
  if (token.endsWith("%")) return clamp01(num(token.slice(0, -1)) / 100);
  return clamp01(num(token) / 255);
}

/** An hsl() saturation or lightness: `40%` or a bare `40`, as 0..1. */
function percent(token: string): number {
  const raw = token.endsWith("%") ? token.slice(0, -1) : token;
  return clamp01(num(raw) / 100);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}

export function themeColorLuminance(color: string): number | null {
  const value = color.trim();

  const hex = HEX.exec(value);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) {
      digits = digits
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
    return fromRgb(channel(0), channel(2), channel(4));
  }

  const fn = FN.exec(value);
  if (!fn) return null;
  const name = fn[1]!.toLowerCase();
  const inner = value.slice(value.indexOf("(") + 1, -1);
  const args = inner.split(/[\s,/]+/).filter(Boolean);
  // three channels, plus an optional alpha
  if (args.length < 3 || args.length > 4) return null;

  let rgb: [number, number, number];
  if (name.startsWith("rgb")) {
    rgb = [rgbChannel(args[0]!), rgbChannel(args[1]!), rgbChannel(args[2]!)];
  } else {
    const hueToken = args[0]!.toLowerCase().replace(/deg$/, "");
    const hue = num(hueToken);
    rgb = hslToRgb(((hue % 360) + 360) % 360, percent(args[1]!), percent(args[2]!));
  }
  // a stray `deg` or a malformed number reads as NaN and lands here
  if (rgb.some((c) => Number.isNaN(c))) return null;
  return fromRgb(rgb[0], rgb[1], rgb[2]);
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
