import { colorTokens } from "../tokens/colors";

const parseHexColor = (hex: string): [number, number, number] | null => {
  const normalized = hex.replace("#", "");
  const components =
    normalized.length === 3
      ? normalized.split("").map((char) => parseInt(char.repeat(2), 16))
      : normalized.match(/.{1,2}/g)?.map((pair) => parseInt(pair, 16));
  if (!components || components.length < 3) {
    return null;
  }
  return components.slice(0, 3) as [number, number, number];
};

const fallbackRgb = parseHexColor(colorTokens.color.brandPrimary) ?? [0, 0, 0];

export const hexToRgba = (hex: string, alpha: number): string => {
  const [r, g, b] = parseHexColor(hex) ?? fallbackRgb;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const { roles, color: colorPalette } = colorTokens;

// ─────────────────────────────────────────────────────────────────────────────
// Theme-resolved base values.
//
// Most callers use light (Swiss minimalism light-first), but dark is available
// by passing `theme: "dark"` to getBadgeVariantTokens / getNotificationToneTokens.
// ─────────────────────────────────────────────────────────────────────────────
export type ThemeName = keyof typeof colorTokens.roles;

const getRoles = (theme: ThemeName = "light") => roles[theme];

// Module-level shortcuts — used by intentVariants (always light).
const lightRoles = roles.light;

const baseSurface = lightRoles.surface;
const baseBorder = lightRoles.border;
const baseText = lightRoles.text;
const baseMutedText = lightRoles.textMuted;
const inverseText = lightRoles.textInverted;
// Dark ink for foregrounds on saturated status fills. White on success/
// warning/danger fails WCAG AA (2.28 / 1.53 / 3.76:1); dark ink clears 4.5:1
// on all three (8.05 / 11.6 / 4.93:1). Theme-independent — the status fills
// are identical in both themes.
const onStatusFillText = baseText; // #181818

const toneAccentValues = {
  info: colorPalette.info,
  success: colorPalette.success,
  warning: colorPalette.warning,
  danger: colorPalette.danger,
  error: colorPalette.danger,
  neutral: baseText,
} as const;

type IntentSurface = {
  backgroundColor: string;
  borderColor: string;
  color: string;
};

const buildIntentSurface = (
  accent: string,
  overrides?: Partial<IntentSurface>,
): IntentSurface => ({
  backgroundColor: hexToRgba(accent, 0.12),
  borderColor: hexToRgba(accent, 0.4),
  color: accent,
  ...overrides,
});

export const intentVariants = {
  info: buildIntentSurface(toneAccentValues.info),
  success: buildIntentSurface(toneAccentValues.success),
  warning: buildIntentSurface(toneAccentValues.warning),
  danger: buildIntentSurface(toneAccentValues.danger),
  error: buildIntentSurface(toneAccentValues.error),
  neutral: {
    backgroundColor: baseSurface,
    borderColor: hexToRgba(baseBorder, 0.35),
    color: baseMutedText,
  },
} as const;

export type IntentVariant = keyof typeof intentVariants;

export const isIntentVariant = (value: string): value is IntentVariant =>
  value in intentVariants;

export const intentAccentColor: Record<IntentVariant, string> =
  toneAccentValues;

export interface IntentVisualConfig {
  accent: string;
  softBackground: string;
  softBorder: string;
  text: string;
  mutedText: string;
  solidBackground: string;
  onSolidText: string;
  iconBackground: string;
}

// INVARIANT: `onSolidText` is the foreground for THIS tone's `solidBackground`.
// The two must always be edited as a pair — every bug in this file's history has
// been a foreground drifting away from the fill it is named for.
//
// The default fill is `$surfaceStrong`, so the default foreground is
// `$onStructure` (16.2 / 7.0 / 9.5 across stub / swiss / ember). It used to be
// `$background`, which is only correct on the light themes: `$background` is the
// deep navy canvas on Ember, giving #0F1B33 on #2A4578 = 1.81:1 — invisible.
const defaultVisual: IntentVisualConfig = {
  accent: "$accent",
  softBackground: "$surfaceMuted",
  softBorder: "$borderColor",
  text: "$color",
  mutedText: "$colorMuted",
  solidBackground: "$surfaceStrong",
  onSolidText: "$onStructure",
  iconBackground: "$surface",
};

// KNOWN GAP (status tones): success/warning/danger/error keep `$background` as
// their solid foreground, which is only correct on stub + ember. Unlike every
// other token here the status FILLS are not theme-stable — Stub darkens them for
// the cream canvas (#166534 / #92400E / #B91C1C) while swiss + ember keep the
// bright originals (#22C55E / #FACC15 / #EF4444) — so no single existing token
// clears AA on all three (`$background`: 6.3 / 2.3 / 7.5 on success). Closing it
// needs a new `onStatus` theme token (dark ink on swiss/ember, paper on stub) in
// all three themes; that is deliberately out of scope here. Left at today's
// value so this change is a no-op for these tones rather than a Swiss
// regression. Note there are currently zero `variant="filled"` status chips and
// zero `variant="solid"` Alerts/Banners in the repo, so this is latent.
const onStatusSolidText = "$background";

export const intentVisualConfigs: Record<IntentVariant, IntentVisualConfig> = {
  info: {
    ...defaultVisual,
    accent: "$accent",
    softBorder: "$accent",
    text: "$accent",
    // The solid fill is the DEEP accent, not `$accent`. Solid intent surfaces
    // carry small text (a 13px chip label), and design-system-v2.md §3 is
    // explicit: white on `$accent` #E2481D is only ~4.1:1 (AA-large), so
    // small-text-on-accent must ride the #B93312 fill. `$accentHard` is that
    // colour on Stub while staying the steel-blue #2A4578 on swiss/ember, so
    // the "info" hue stays coherent per theme. With `$onStructure`: 5.7 / 9.5 /
    // 9.5 — AA in all three. (Same trade PriceBlock
    // already make via `$brandSecondaryHover`.)
    solidBackground: "$accentHard",
  },
  success: {
    ...defaultVisual,
    accent: "$success",
    softBorder: "$success",
    text: "$success",
    solidBackground: "$success",
    onSolidText: onStatusSolidText,
  },
  warning: {
    ...defaultVisual,
    accent: "$warning",
    softBorder: "$warning",
    text: "$warning",
    solidBackground: "$warning",
    onSolidText: onStatusSolidText,
  },
  danger: {
    ...defaultVisual,
    accent: "$danger",
    softBorder: "$danger",
    text: "$danger",
    solidBackground: "$danger",
    onSolidText: onStatusSolidText,
  },
  error: {
    ...defaultVisual,
    accent: "$danger",
    softBorder: "$danger",
    text: "$danger",
    solidBackground: "$danger",
    onSolidText: onStatusSolidText,
  },
  neutral: {
    ...defaultVisual,
    accent: "$color",
    softBorder: "$borderColor",
    text: "$color",
    solidBackground: "$surfaceStrong",
    iconBackground: "$surfaceStrong",
  },
};

export const feedbackVariants = ["soft", "solid", "surface"] as const;

export type FeedbackVariant = (typeof feedbackVariants)[number];

export interface FeedbackVariantTokens {
  backgroundColor: string;
  borderColor: string;
  titleColor: string;
  descriptionColor: string;
  iconColor: string;
  iconBackground: string;
}

type FeedbackTokenMap = Record<FeedbackVariant, FeedbackVariantTokens>;

const buildFeedbackTokens = (
  visual: IntentVisualConfig,
  tone: IntentVariant,
): FeedbackTokenMap => {
  // success / warning / danger solid fills are saturated, high-luminance — a
  // white foreground fails WCAG AA on them (mirrors the badge solid fix), so
  // the solid Alert/Banner foreground flips to dark ink. info and neutral use
  // the tone's own `onSolidText`, which is paired to its `solidBackground`.
  //
  // (This previously read "neutral (surfaceStrong) keep the default white, which
  // already passes" — that was false. The default was `$background`, which is
  // only white on swiss; on Ember it is the #0F1B33 page canvas, so neutral
  // solid rendered #0F1B33 on the #2A4578 `$surfaceStrong` fill = 1.81:1.
  // `$onStructure` is the actual near-white in every theme and is what the
  // default now points at.)
  const isStatusFill =
    tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "error";
  const solidForeground = isStatusFill ? onStatusFillText : visual.onSolidText;
  return {
    soft: {
      backgroundColor: visual.softBackground,
      borderColor: visual.softBorder,
      titleColor: visual.text,
      descriptionColor: visual.mutedText,
      iconColor: visual.accent,
      iconBackground: visual.iconBackground,
    },
    surface: {
      backgroundColor: "$surface",
      borderColor: "$borderColor",
      titleColor: "$color",
      descriptionColor: "$colorMuted",
      iconColor: visual.accent,
      iconBackground: "$surfaceStrong",
    },
    solid: {
      backgroundColor: visual.solidBackground,
      borderColor: visual.solidBackground,
      titleColor: solidForeground,
      // On status fills the lowest-headroom case is danger (#181818 = 4.72:1),
      // so the description stays full-strength ink rather than translucent.
      descriptionColor: isStatusFill
        ? solidForeground
        : hexToRgba(inverseText, 0.85),
      iconColor: solidForeground,
      iconBackground: hexToRgba(baseText, 0.16),
    },
  };
};

export interface IntentTokenSet extends IntentVisualConfig {
  feedback: FeedbackTokenMap;
}

const intentTokenSets = Object.fromEntries(
  (
    Object.entries(intentVisualConfigs) as Array<
      [IntentVariant, IntentVisualConfig]
    >
  ).map(([tone, visual]) => [
    tone,
    {
      ...visual,
      feedback: buildFeedbackTokens(visual, tone),
    },
  ]),
) as Record<IntentVariant, IntentTokenSet>;

export const getIntentTokens = (tone: IntentVariant = "info"): IntentTokenSet =>
  intentTokenSets[tone] ?? intentTokenSets.info;

export const getFeedbackTokens = (
  tone: IntentVariant,
  variant: FeedbackVariant = "soft",
): FeedbackVariantTokens => getIntentTokens(tone).feedback[variant];

export const badgeVariants = ["soft", "solid", "outline"] as const;

export type BadgeVariant = (typeof badgeVariants)[number];

export interface BadgeVariantTokens {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  iconColor: string;
  iconBackground: string;
  dotColor: string;
}

const toneAccentMap: Record<IntentVariant, string> = {
  info: toneAccentValues.info,
  success: toneAccentValues.success,
  warning: toneAccentValues.warning,
  danger: toneAccentValues.danger,
  error: toneAccentValues.error,
  neutral: baseText,
};

const buildBadgeVariantTokens = (
  accent: string,
  textAccent?: string,
  // Foreground on the solid fill. Status tones pass dark ink so the label
  // clears WCAG AA on saturated fills; neutral keeps white (default).
  solidText: string = inverseText,
): Record<BadgeVariant, BadgeVariantTokens> => ({
  soft: {
    backgroundColor: hexToRgba(accent, 0.12),
    borderColor: hexToRgba(accent, 0.6),
    textColor: textAccent ?? accent,
    iconColor: textAccent ?? accent,
    iconBackground: "transparent",
    dotColor: accent,
  },
  solid: {
    backgroundColor: accent,
    borderColor: accent,
    textColor: solidText,
    iconColor: solidText,
    iconBackground: hexToRgba("#000000", 0.15),
    dotColor: solidText,
  },
  outline: {
    // `transparent`, NOT `baseSurface`. `baseSurface` is the SWISS (white)
    // surface baked in at module scope, so an outline badge painted a hard
    // #FFFFFF rectangle in every theme — a white block in an Ember (navy) row,
    // and an off-white patch on Stub's cream. An outline badge is defined by
    // its border; the fill is whatever it sits on, which is the only reading
    // that survives being placed on `$background`, `$surface` or
    // `$surfaceMuted`. `Chip`'s own outline variant already does exactly this
    // (see display/Chip.tsx), and `soft` composites over the surface too — this
    // makes Badge the third of three consistent, not the odd one out.
    backgroundColor: "transparent",
    borderColor: accent,
    textColor: textAccent ?? accent,
    iconColor: textAccent ?? accent,
    iconBackground: "transparent",
    dotColor: accent,
  },
});

// Neutral badge uses a medium-gray accent so it's legible on both light and
// dark surfaces.  The other tones derive from `toneAccentMap` which works fine
// because their accent hues have enough contrast, but `baseText` (the neutral
// accent) is near-black (#181818) and disappears on dark backgrounds.
const neutralAccent = "#7B8BA4";

const neutralBadgeTokens: Record<BadgeVariant, BadgeVariantTokens> = {
  soft: {
    backgroundColor: hexToRgba(neutralAccent, 0.12),
    borderColor: hexToRgba(neutralAccent, 0.36),
    textColor: neutralAccent,
    iconColor: neutralAccent,
    iconBackground: "transparent",
    dotColor: neutralAccent,
  },
  solid: {
    // Dark ink on the mid-tone slate fill: white was only 3.46:1 (FAIL),
    // ink clears WCAG AA at 5.13:1.
    backgroundColor: neutralAccent,
    borderColor: neutralAccent,
    textColor: onStatusFillText,
    iconColor: onStatusFillText,
    iconBackground: hexToRgba("#000000", 0.12),
    dotColor: onStatusFillText,
  },
  outline: {
    // See the note on `buildBadgeVariantTokens.outline` — same fixed-white bug.
    backgroundColor: "transparent",
    borderColor: hexToRgba(neutralAccent, 0.45),
    textColor: neutralAccent,
    iconColor: neutralAccent,
    iconBackground: "transparent",
    dotColor: neutralAccent,
  },
};

const badgeTokenCache = new Map<
  IntentVariant,
  Record<BadgeVariant, BadgeVariantTokens>
>();

// Warning yellow (#FACC15) has poor contrast as text on both light and dark
// surfaces.  Use a darker amber for badge text/icon while keeping the bright
// yellow for borders, dots, and solid-variant backgrounds.
const warningTextAccent = "#B8860B"; // dark-goldenrod — WCAG AA on both themes

export const getBadgeVariantTokens = (
  tone: IntentVariant = "neutral",
  variant: BadgeVariant = "soft",
): BadgeVariantTokens => {
  const cached = badgeTokenCache.get(tone);
  if (cached) {
    return cached[variant];
  }
  const accent = toneAccentMap[tone] ?? toneAccentMap.neutral;
  const textOverride = tone === "warning" ? warningTextAccent : undefined;
  // success / warning / danger are saturated, high-luminance fills — white
  // labels fail WCAG AA on them, so the solid foreground is dark ink. info
  // (steel blue) and neutral stay on the default (white) which already passes.
  const isStatusFill =
    tone === "success" ||
    tone === "warning" ||
    tone === "danger" ||
    tone === "error";
  const solidText = isStatusFill ? onStatusFillText : inverseText;
  const tokens =
    tone === "neutral"
      ? neutralBadgeTokens
      : buildBadgeVariantTokens(accent, textOverride, solidText);
  badgeTokenCache.set(tone, tokens);
  return tokens[variant];
};

export interface NotificationToneTokens {
  frameBackground: string;
  frameBorder: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  iconBackground: string;
  iconBorder: string;
  iconColor: string;
}

const notificationToneCache = new Map<string, NotificationToneTokens>();

export const getNotificationToneTokens = (
  tone: IntentVariant = "info",
  theme: ThemeName = "light",
): NotificationToneTokens => {
  const key = `${tone}:${theme}`;
  const cached = notificationToneCache.get(key);
  if (cached) {
    return cached;
  }
  const accentTokens = getBadgeVariantTokens(tone, "solid");
  const accent = accentTokens.backgroundColor;
  const r = getRoles(theme);
  const tokens: NotificationToneTokens = {
    frameBackground: r.surface,
    frameBorder: r.border,
    textPrimary: r.text,
    textSecondary: hexToRgba(r.text, 0.72),
    accent,
    iconBackground: hexToRgba(accent, 0.12),
    iconBorder: hexToRgba(accent, 0.4),
    iconColor: accent,
  };
  notificationToneCache.set(key, tokens);
  return tokens;
};
