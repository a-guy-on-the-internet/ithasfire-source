/**
 * Convert a `#RGB` / `#RRGGBB` hex string into an `rgba(r, g, b, a)` string.
 *
 * Used to derive low-alpha chrome fills (hover / active / dividers) from a
 * SOLID theme token — e.g. `onStructure` — so the alpha overlay tracks the
 * theme (white-alpha in Ember, paper-alpha in Stub) instead of a hardcoded
 * `rgba(255,255,255,…)`.
 *
 * A malformed input falls back to neutral grey so a bad token can never blank
 * a fill entirely. Grey (not the white this used to return) because the
 * fallback has to stay visible on BOTH canvases — white degrades to invisible
 * on Stub's warm paper, which is the shipped default.
 */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  if (full.length !== 6 || /[^0-9a-fA-F]/.test(full)) {
    return `rgba(128, 128, 128, ${alpha})`;
  }
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
