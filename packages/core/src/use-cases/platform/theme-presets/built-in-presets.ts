import type { ThemePreset } from "@th/types/theme-preset";

/**
 * Built-in seasonal theme presets that ship with the platform.
 * Staff can activate these without creating custom presets.
 *
 * Each only stores the token overrides that differ from the base dark theme.
 */
export const BUILT_IN_PRESETS: ThemePreset[] = [
  {
    slug: "default",
    name: "Default (Dark)",
    tokens: {},
    builtIn: true,
  },
  {
    slug: "christmas",
    name: "Christmas",
    tokens: {
      background: "#0C1A0C",
      backgroundStrong: "#1A2E1A",
      surface: "#12231A",
      surfaceMuted: "#1A2E22",
      surfaceRaised: "#15291C",
      accent: "#C41E3A",
      accentSoft: "rgba(196, 30, 58, 0.18)",
      accentHard: "#8B0000",
      accentHover: "#E2334D",
      borderColor: "#2A4A32",
      borderColorHover: "#C41E3A",
      success: "#22C55E",
      info: "#5E8AD4",
    },
    builtIn: true,
  },
  {
    slug: "halloween",
    name: "Halloween",
    tokens: {
      background: "#0D0A0F",
      backgroundStrong: "#1C1424",
      surface: "#161020",
      surfaceMuted: "#1E1628",
      surfaceRaised: "#1A1224",
      accent: "#FF6B1A",
      accentSoft: "rgba(255, 107, 26, 0.18)",
      accentHard: "#8B4513",
      accentHover: "#FF8C42",
      borderColor: "#362A4A",
      borderColorHover: "#FF6B1A",
      warning: "#FF6B1A",
      danger: "#9B2C2C",
    },
    builtIn: true,
  },
  {
    slug: "valentines",
    name: "Valentine's Day",
    tokens: {
      background: "#0F0A0D",
      backgroundStrong: "#241A20",
      surface: "#1A1218",
      surfaceMuted: "#221820",
      surfaceRaised: "#1E1519",
      accent: "#E91E63",
      accentSoft: "rgba(233, 30, 99, 0.18)",
      accentHard: "#AD1457",
      accentHover: "#F06292",
      borderColor: "#4A2A3A",
      borderColorHover: "#E91E63",
    },
    builtIn: true,
  },
  {
    slug: "new-years",
    name: "New Year's Eve",
    tokens: {
      background: "#080810",
      backgroundStrong: "#141428",
      surface: "#101020",
      surfaceMuted: "#181830",
      surfaceRaised: "#141428",
      accent: "#FFD700",
      accentSoft: "rgba(255, 215, 0, 0.15)",
      accentHard: "#DAA520",
      accentHover: "#FFE44D",
      borderColor: "#2A2A50",
      borderColorHover: "#FFD700",
      colorMuted: "#B0B0D0",
    },
    builtIn: true,
  },
  {
    slug: "summer",
    name: "Summer Vibes",
    tokens: {
      background: "#0A1018",
      backgroundStrong: "#14283A",
      surface: "#0F1E2E",
      surfaceMuted: "#162636",
      surfaceRaised: "#132232",
      accent: "#00BCD4",
      accentSoft: "rgba(0, 188, 212, 0.18)",
      accentHard: "#0097A7",
      accentHover: "#26C6DA",
      borderColor: "#1E3A4A",
      borderColorHover: "#00BCD4",
      success: "#4CAF50",
      warning: "#FFB300",
    },
    builtIn: true,
  },
  {
    slug: "st-patricks",
    name: "St. Patrick's Day",
    tokens: {
      background: "#060E08",
      backgroundStrong: "#0E2414",
      surface: "#0A1A0E",
      surfaceMuted: "#122216",
      surfaceRaised: "#0E1E12",
      accent: "#4CAF50",
      accentSoft: "rgba(76, 175, 80, 0.18)",
      accentHard: "#2E7D32",
      accentHover: "#66BB6A",
      borderColor: "#1E3E24",
      borderColorHover: "#4CAF50",
    },
    builtIn: true,
  },
];

/** Find a built-in preset by slug. */
export function findBuiltInPreset(slug: string): ThemePreset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.slug === slug);
}
