/**
 * Platform-detection helpers for keyboard shortcuts and UI hints.
 *
 * Detects macOS / iOS so we can show ⌘ instead of Ctrl, ⇧ instead of Shift, etc.
 * Safe to call during SSR (falls back to non-Mac).
 */
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);

/** Modifier key symbol: ⌘ on Mac, Ctrl on Windows/Linux */
export const MOD_KEY = isMac ? "⌘" : "Ctrl+";

/** Shift key symbol: ⇧ on Mac, Shift+ on Windows/Linux */
export const SHIFT_KEY = isMac ? "⇧" : "Shift+";

/**
 * Build a human-readable shortcut hint string.
 *
 * @example
 * shortcutHint("S")          // "⌘S" on Mac, "Ctrl+S" on Windows
 * shortcutHint("S", true)    // "⌘⇧S" on Mac, "Ctrl+Shift+S" on Windows
 */
export function shortcutHint(key: string, shift = false): string {
  if (shift) {
    return `${MOD_KEY}${SHIFT_KEY}${key}`;
  }
  return `${MOD_KEY}${key}`;
}
