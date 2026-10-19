/**
 * The platform theme PRESET overlay (`trpc.platform.getActiveTheme`), merged
 * over a base theme snapshot.
 *
 * One function so the two places that need "the platform's theme as the
 * viewer will actually see it" cannot disagree: `ActiveThemeInjector` (which
 * applies it) and the admin embed configurator (which seeds its colour pickers
 * with the light theme an embed will render).
 */

/** The slice of `getActiveTheme`'s payload this merge reads. */
export type ActiveThemePresets =
  | {
      activeSlug: string | null;
      presets: ReadonlyArray<{ slug: string; tokens: Record<string, string> }>;
    }
  | null
  | undefined;

export type MergedPlatformTheme = {
  /** Base snapshot with the active preset's tokens laid over it. */
  tokens: Record<string, string>;
  /** The active preset's own tokens, or null when none (or an empty one) is active. */
  presetTokens: Record<string, string> | null;
};

export function mergeActivePreset(
  base: Record<string, string>,
  data: ActiveThemePresets,
): MergedPlatformTheme {
  const activeSlug = data?.activeSlug ?? null;
  const preset = activeSlug
    ? data?.presets.find((p) => p.slug === activeSlug)
    : null;
  if (!preset || Object.keys(preset.tokens).length === 0) {
    return { tokens: { ...base }, presetTokens: null };
  }
  const tokens: Record<string, string> = { ...base, ...preset.tokens };
  // Derive `backgroundInverted` from the preset's `accent` when the preset
  // overrides accent but doesn't explicitly set backgroundInverted, so primary
  // buttons (which use $backgroundInverted) match the preset's brand colour.
  if (preset.tokens.accent && !preset.tokens.backgroundInverted) {
    tokens.backgroundInverted = preset.tokens.accent;
  }
  return { tokens, presetTokens: preset.tokens };
}
