/**
 * "Can the faces we registered actually draw this string?"
 *
 * ── THE ONE FAILURE THIS GUARDS, AS MEASURED ────────────────────────────────
 * The vendored OG faces are Latin (plus Cyrillic — Montserrat ships it, so
 * "Вечер джаза" draws from our own files with no fallback at all). For a script
 * NONE of them cover, rendering an entirely-CJK title was run both ways:
 *
 *   - with egress, `next/og` quietly fetches
 *     `fonts.googleapis.com/css2?family=Noto+Sans+JP&text=…` mid-render (its
 *     undocumented `loadAdditionalAsset` path) and draws real glyphs. That is
 *     an unbounded outbound request on a public, unauthenticated, cacheable GET
 *     whose text is attacker-influenced — not something to depend on;
 *   - with that fetch failing (a locked-down egress, an outage), it logs
 *     "Failed to load dynamic font" and draws a row of TOFU boxes.
 *
 * Neither is an artifact worth serving, and which one you get depends on a
 * third party being reachable. So a title our own faces cannot draw at all
 * takes the static poster: deterministic, branded, and it also means those
 * inputs never reach the dynamic-font path.
 *
 * ── AND THE FAILURES IT DELIBERATELY DOES NOT GUARD ─────────────────────────
 * This is an ALL-OR-NOTHING test, never a "is every glyph present" test.
 * "Comedy Night 🎤" losing its emoji is a fine share card and must keep
 * rendering; only a title with NO renderable codepoint at all is worth
 * degrading for. Shipping another megabyte of CJK font to fix the first case is
 * not on the table.
 *
 * ── FAIL OPEN ───────────────────────────────────────────────────────────────
 * Every unparseable input answers "renderable". A cmap we cannot read is not
 * evidence that a title is undrawable, and treating it as such would swap the
 * real stub for the static poster across the board on a font-format change.
 */

/** Format 4 covers the BMP; format 12 covers the supplementary planes too. */
type CmapLookup = (codepoint: number) => boolean;

const TAG_CMAP = 0x636d6170; // "cmap"

/** Byte offset of the `cmap` table, or null. */
const findCmapOffset = (view: DataView): number | null => {
  if (view.byteLength < 12) return null;
  const numTables = view.getUint16(4);
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > view.byteLength) return null;
    if (view.getUint32(record) === TAG_CMAP) {
      const offset = view.getUint32(record + 8);
      return offset + 4 <= view.byteLength ? offset : null;
    }
  }
  return null;
};

/** Segment-mapped BMP coverage (`cmap` format 4). */
const parseFormat4 = (view: DataView, start: number): CmapLookup | null => {
  if (start + 14 > view.byteLength) return null;
  const segCount = view.getUint16(start + 6) / 2;
  if (!Number.isInteger(segCount) || segCount <= 0) return null;

  const endCodes = start + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  if (idRangeOffsets + segCount * 2 > view.byteLength) return null;

  return (cp) => {
    if (cp > 0xffff) return false;
    for (let i = 0; i < segCount; i += 1) {
      const end = view.getUint16(endCodes + i * 2);
      if (end < cp) continue;
      const begin = view.getUint16(startCodes + i * 2);
      if (begin > cp) return false;

      const rangeOffsetAt = idRangeOffsets + i * 2;
      const rangeOffset = view.getUint16(rangeOffsetAt);
      if (rangeOffset === 0) {
        const delta = view.getInt16(idDeltas + i * 2);
        return ((cp + delta) & 0xffff) !== 0;
      }
      const glyphAt = rangeOffsetAt + rangeOffset + (cp - begin) * 2;
      if (glyphAt + 2 > view.byteLength) return false;
      return view.getUint16(glyphAt) !== 0;
    }
    return false;
  };
};

/** Segmented coverage (`cmap` format 12) — the full Unicode range. */
const parseFormat12 = (view: DataView, start: number): CmapLookup | null => {
  if (start + 16 > view.byteLength) return null;
  const groupCount = view.getUint32(start + 12);
  const groups = start + 16;
  if (groups + groupCount * 12 > view.byteLength) return null;

  return (cp) => {
    for (let i = 0; i < groupCount; i += 1) {
      const at = groups + i * 12;
      const begin = view.getUint32(at);
      if (begin > cp) return false;
      if (view.getUint32(at + 4) >= cp) return view.getUint32(at + 8) !== 0;
    }
    return false;
  };
};

/** Every readable Unicode subtable in one font. */
const parseFontLookups = (data: ArrayBuffer): CmapLookup[] => {
  try {
    const view = new DataView(data);
    const cmap = findCmapOffset(view);
    if (cmap === null) return [];

    const lookups: CmapLookup[] = [];
    const subtableCount = view.getUint16(cmap + 2);
    for (let i = 0; i < subtableCount; i += 1) {
      const record = cmap + 4 + i * 8;
      if (record + 8 > view.byteLength) break;
      const start = cmap + view.getUint32(record + 4);
      if (start + 2 > view.byteLength) continue;

      const format = view.getUint16(start);
      // Only the formats the vendored faces actually use. An unrecognised
      // format is skipped, not guessed at; if NO subtable parses, the caller
      // fails open.
      const lookup =
        format === 4
          ? parseFormat4(view, start)
          : format === 12
            ? parseFormat12(view, start)
            : null;
      if (lookup) lookups.push(lookup);
    }
    return lookups;
  } catch {
    return [];
  }
};

/**
 * Memoised per font array — `loadOgFonts` hands back the same memoised array
 * for the life of the process, so the cmaps are walked once.
 */
const lookupCache = new WeakMap<object, CmapLookup[]>();

const lookupsFor = (fonts: readonly { data: ArrayBuffer }[]): CmapLookup[] => {
  const cached = lookupCache.get(fonts as unknown as object);
  if (cached) return cached;
  const lookups = fonts.flatMap((font) => parseFontLookups(font.data));
  lookupCache.set(fonts as unknown as object, lookups);
  return lookups;
};

/**
 * True when at least one non-whitespace codepoint of `text` is drawable by one
 * of `fonts` — i.e. when rendering `text` would put SOMETHING on the canvas.
 *
 * Also true for empty/whitespace text: the stub has its own "Untitled event"
 * placeholder for that, and this function's only job is the all-or-nothing
 * glyph question.
 */
export const hasRenderableGlyph = (
  text: string | null | undefined,
  fonts: readonly { data: ArrayBuffer }[],
): boolean => {
  const value = (text ?? "").trim();
  if (!value) return true;

  const lookups = lookupsFor(fonts);
  // No readable cmap anywhere ⇒ no evidence ⇒ fail open.
  if (lookups.length === 0) return true;

  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    // Whitespace is not ink even when the face covers it.
    if (/\s/u.test(char)) continue;
    if (lookups.some((covers) => covers(cp))) return true;
  }
  return false;
};
