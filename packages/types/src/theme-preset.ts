/**
 * A named theme preset (e.g., "Christmas", "Halloween").
 *
 * `tokens` is a partial map — only overridden values are stored.
 * At runtime the app merges these on top of the base dark theme.
 */
export interface ThemePreset {
  /** URL-safe slug, e.g. "christmas-2025". Must be unique. */
  slug: string;
  /** Human-readable name, e.g. "Christmas 2025". */
  name: string;
  /** Partial token overrides keyed by ThemeTokenKey. */
  tokens: Record<string, string>;
  /** Whether this is a built-in preset that ships with the platform. */
  builtIn?: boolean;
}

/**
 * Shape stored under the `themePresets` PlatformSetting key.
 * Serialised as JSON string in the DB.
 */
export interface ThemePresetsConfig {
  /** Ordered list of available presets. */
  presets: ThemePreset[];
}

/**
 * Shape stored under the `activeThemePreset` PlatformSetting key.
 * Serialised as JSON string in the DB.
 * `null` or missing means "use base dark theme".
 */
export interface ActiveThemePresetConfig {
  /** Slug of the active preset, or null for default. */
  slug: string | null;
}
