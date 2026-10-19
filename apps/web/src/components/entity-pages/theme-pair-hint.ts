import { isSafeThemeColor } from "@th/core/lib/theme-color";

import { themeColorLuminance } from "@/lib/theme-color-luminance";

/**
 * True when exactly one of background and text is set and the page cannot
 * measure it (a colour name). The public page gives a lone colour a partner
 * by contrast, and drops one it cannot measure (`resolveThemePair`), so the
 * owner is told before saving a colour that will not show.
 */
export function loneColorUnmeasurable(bg: string, text: string): boolean {
  const set = [bg.trim(), text.trim()].filter(Boolean);
  if (set.length !== 1) return false;
  return isSafeThemeColor(set[0]) && themeColorLuminance(set[0]!) == null;
}
