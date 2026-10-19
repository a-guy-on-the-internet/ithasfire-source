/**
 * Canonical auto-generated display name for a newly enrolled passkey.
 *
 * Every surface that enrolls a passkey (web account settings, web sign-up,
 * scanner settings, scanner first-run) needs a human-readable label for the
 * credential. Those four call sites each rolled their own string and had
 * already drifted apart — one produced `"macOS · 7/27/2026"`, another
 * `"Tom's iPhone"`, another a bare person name with no device hint at all. One
 * implementation removes the drift.
 *
 * This module is deliberately ENVIRONMENT-PURE: it never touches `navigator`,
 * `window`, react-native `Platform`, or `Date`. Callers pass the device label
 * and person name in. That keeps it trivially testable from a node vitest run
 * on both the web and native side, and lets a richer label source (e.g. one
 * derived from the credential's AAGUID) slot in later without reshaping the
 * API.
 *
 * The source is kept ASCII-only on purpose. Non-ASCII characters here are
 * either invisible (which makes the file read as binary to grep and lets an
 * assertion silently disappear in review) or RTL (which reorders comments in
 * an editor). Every non-ASCII character this module produces or matches is
 * spelled as a numeric escape.
 */

/**
 * Hard cap on a passkey display name.
 *
 * Better Auth's passkey plugin validates `name` as a bare `z.string()` with no
 * max length on BOTH `/passkey/verify-registration` and
 * `/passkey/update-passkey` (`@better-auth/passkey/dist/index.mjs:290` and
 * `:577-580`). So whatever the client sends lands verbatim in `Passkey.name`
 * (`packages/db/prisma/auth.prisma:306`, an unbounded Postgres text column) and
 * is then rendered in the settings list. Bounding it here keeps a hostile or
 * absurd client-supplied label from becoming an unbounded row + a blown-out
 * list row.
 */
export const PASSKEY_NAME_MAX_LENGTH = 64;

/** Used whenever there is nothing usable to build a name from. */
const FALLBACK_PASSKEY_NAME = "Passkey";

/**
 * Typographic apostrophe (U+2019), matching the codebase's typographic
 * conventions. Never the ASCII `'`. Spelled as a code point so an editor,
 * a copy/paste, or a locale-mangling tool cannot silently downgrade it.
 */
const TYPOGRAPHIC_APOSTROPHE = String.fromCodePoint(0x2019);

/**
 * Upper bound on collision-suffix attempts. Nobody legitimately has 99
 * same-named passkeys; the cap exists so a pathological `existingNames` list
 * can't spin forever.
 */
const MAX_DISAMBIGUATION_ATTEMPTS = 99;

/**
 * Characters removed by {@link normalizePasskeyName}: the control characters
 * plus the invisible / bidi-spoofing subset of the Unicode format category.
 *
 * Every range is an explicit escape rather than a `\p{Cc}`/`\p{Cf}` property
 * escape. Two reasons, in order of importance:
 *
 * 1. `\p{Cf}` is too wide by exactly the two format characters that carry
 *    meaning, and this function now receives USER-TYPED text (the rename field
 *    in web account settings), where mangling a name is content corruption:
 *    - U+200C ZERO WIDTH NON-JOINER is *orthographically required* in Persian,
 *      Devanagari, Bengali, Malayalam and Sinhala. Removing it silently
 *      respells real words: a Persian device name written as two words joined
 *      by a ZWNJ collapses into one wrong token.
 *    - U+200D ZERO WIDTH JOINER is load-bearing inside emoji. Removing it
 *      decomposes every ZWJ sequence (man-technologist becomes man + laptop,
 *      the rainbow flag becomes a white flag + a rainbow).
 *    Neither is a spoofing vector. The bidi-override and zero-width-payload
 *    tricks this strip exists to defeat all live in the ranges below, and are
 *    all still removed.
 * 2. Portability. This module also runs under Hermes (`apps/scanner` calls
 *    `derivePasskeyName`), and an unsupported property escape is a
 *    `SyntaxError` at literal-evaluation time — a crashed enrollment, not a
 *    degraded label. Hermes for RN 0.81 does in fact ship property escapes
 *    (`hermes -version` lists "Unicode RegExp Property Escapes"), but plain
 *    ranges need no such per-engine claim to keep holding.
 *
 * Ranges, in the order they appear below:
 * - U+0000-U+001F   C0 controls. The `\t\n\v\f\r` subset becomes a space
 *                   rather than nothing — see {@link WHITESPACE_CONTROLS}.
 * - U+007F-U+009F   DEL and the C1 controls.
 * - U+00AD          SOFT HYPHEN (invisible).
 * - U+061C          ARABIC LETTER MARK (invisible bidi control).
 * - U+180E          MONGOLIAN VOWEL SEPARATOR (zero width since Unicode 6.3).
 * - U+200B          ZERO WIDTH SPACE.
 * - U+200E-U+200F   LEFT-TO-RIGHT / RIGHT-TO-LEFT MARK.
 * - U+202A-U+202E   bidi embeddings and overrides (the classic display spoof).
 * - U+2060-U+2064   WORD JOINER and the invisible math operators.
 * - U+2066-U+2069   bidi isolates.
 * - U+206A-U+206F   deprecated shaping / digit-shape format controls.
 * - U+FEFF          ZERO WIDTH NO-BREAK SPACE / BOM.
 * - U+FFF9-U+FFFB   interlinear annotation controls.
 * - U+13430-U+1343F Egyptian hieroglyph joiners / segment + enclosure controls.
 * - U+1BCA0-U+1BCA3 Duployan shorthand overlap and step controls.
 * - U+1D173-U+1D17A musical beam / tie / slur / phrase controls.
 * - U+E0001 and
 *   U+E0020-U+E007F LANGUAGE TAG and the TAG characters.
 *
 * The rule the enumeration follows, so that additions stay consistent: strip a
 * format character when it is ZERO-WIDTH (it can hide a payload or reorder a
 * display and removing it cannot change how legitimate text reads); keep it
 * when it RENDERS or is orthographically required. That is the whole of
 * `\p{Cf}` except the following, which are kept on purpose:
 * - U+200C / U+200D, per the two bullets above.
 * - U+0600-U+0605, U+06DD, U+0890, U+0891, U+08E2, U+110BD, U+110CD — Arabic
 *   and Kaithi number/ayah signs, which draw a visible mark over or before the
 *   digits that follow.
 * - U+070F SYRIAC ABBREVIATION MARK, which draws a visible overline.
 *
 * Also untouched, because they are not `\p{Cf}` at all and must never be
 * mistaken for invisibles: combining marks (`\p{Mn}`/`\p{Mc}` — i.e. every
 * accented Latin, Arabic, Hebrew and Indic name) and the variation selectors
 * U+FE00-U+FE0F (emoji presentation).
 *
 * Deliberately STILL stripped even though they appear inside legitimate emoji:
 * the U+E00xx tag characters. They are the standard invisible-text smuggling
 * channel, and their only common legitimate use is the three UK subdivision
 * flags, which degrade to a plain black flag rather than to corrupted text.
 */
const STRIPPED_CHARACTERS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/gu;

/**
 * The subset of {@link STRIPPED_CHARACTERS} that becomes a space instead of
 * nothing, so a pasted multi-line value reads as `"Tom's iPhone"` and not
 * `"Tom'siPhone"`. Non-global on purpose: `.test` on a `/g` regex carries
 * `lastIndex` state between calls.
 */
const WHITESPACE_CONTROLS = /[\t\n\v\f\r]/;

/**
 * Unpaired UTF-16 surrogates.
 *
 * Under the `u` flag a valid surrogate PAIR is a single code point above
 * U+FFFF and therefore does NOT match this class, so every non-BMP character
 * (all astral emoji) passes through intact while a stray half is removed.
 * `{"name":"\ud83d"}` is valid JSON and reaches this module, and the truncation
 * guard below only covers the cut it makes itself — this covers the input.
 * Verified byte-identical on V8 and on Hermes for RN 0.81.
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/gu;

/**
 * Normalize a client-supplied passkey name.
 *
 * Drops unpaired surrogates, applies Unicode NFC, strips control and invisible
 * characters, collapses internal whitespace runs to single spaces, trims, and
 * caps length. Returns null for empty/blank input.
 *
 * NFC runs because the result is compared against existing names to build a
 * collision suffix. macOS text input emits DECOMPOSED forms, so without it a
 * name typed on a Mac (`e` + U+0301 COMBINING ACUTE ACCENT) and the same
 * visible name derived elsewhere (U+00E9 LATIN SMALL LETTER E WITH ACUTE) are
 * different code-unit sequences: no collision is detected, and the settings
 * list shows two rows with visually identical names — exactly what the suffix
 * exists to prevent. NFC also makes the length cap deterministic, since a
 * decomposed accent costs two code units and a composed one costs one.
 *
 * Unpaired surrogates are removed BEFORE NFC so normalization sees well-formed
 * UTF-16: a stray half sitting between a base letter and its combining mark
 * would otherwise block composition and survive as an uncomposed pair.
 *
 * (This is name normalization, not HTML sanitization: the value is escaped at
 * its render sink. Prose fields use `sanitizePlainText` in
 * `packages/core/src/lib/sanitize-plain-text.ts`, which additionally runs a
 * real HTML parser — that lives in core because it needs a dependency this
 * shared, RN-consumed package must not take.)
 */
export function normalizePasskeyName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string") return null;

  const wellFormed = raw.replace(UNPAIRED_SURROGATE, "");
  const composed = wellFormed.normalize("NFC");
  const withoutControls = composed.replace(STRIPPED_CHARACTERS, (ch) =>
    WHITESPACE_CONTROLS.test(ch) ? " " : "",
  );
  const collapsed = withoutControls.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;

  const capped = truncate(collapsed, PASSKEY_NAME_MAX_LENGTH);
  return capped || null;
}

export interface DerivePasskeyNameInput {
  /** Human-readable device/credential label, e.g. "macOS", "iPhone", "Windows PC". */
  deviceLabel?: string | null;
  /** The signed-in person's display name, if known. */
  userName?: string | null;
  /** Names already in use for this user — used to disambiguate. */
  existingNames?: readonly (string | null | undefined)[];
}

/** Always returns a non-empty, normalized, collision-free name. */
export function derivePasskeyName(input: DerivePasskeyNameInput): string {
  // Normalize the PARTS first so a blank/whitespace-only label (e.g. a web
  // caller forwarding an empty `navigator.platform`) counts as absent instead
  // of composing "Tom’s ".
  const deviceLabel = normalizePasskeyName(input.deviceLabel);
  const userName = normalizePasskeyName(input.userName);

  const base = composeName(userName, deviceLabel, PASSKEY_NAME_MAX_LENGTH);

  const taken = new Set(
    (input.existingNames ?? [])
      .map((name) => normalizePasskeyName(name)?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );

  if (!taken.has(base.toLowerCase())) return base;

  for (let counter = 2; counter <= MAX_DISAMBIGUATION_ATTEMPTS; counter += 1) {
    const candidate = withCollisionSuffix(userName, deviceLabel, counter);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }

  // Best effort: every suffix up to the cap is taken. Return the last
  // candidate rather than looping or throwing — a duplicate label is a
  // cosmetic problem, a failed enrollment is not.
  return withCollisionSuffix(
    userName,
    deviceLabel,
    MAX_DISAMBIGUATION_ATTEMPTS,
  );
}

/**
 * Compose the display name from the (already normalized) parts, within
 * `budget` UTF-16 code units.
 *
 * Deliberately NO date in the name. The settings UI already renders
 * "Added <date>" on its own line directly beneath the name, so a date here
 * duplicated an adjacent field. Collision suffixes are the disambiguator
 * instead — please don't "helpfully" add the date back.
 *
 * The budget is a parameter rather than the constant because a colliding name
 * has to fit the same cap MINUS its `" (n)"` suffix, and it must shed those
 * characters from the same end as a first-time name would — see
 * {@link withCollisionSuffix}.
 */
function composeName(
  userName: string | null,
  deviceLabel: string | null,
  budget: number,
): string {
  if (userName && deviceLabel) {
    return composePossessive(userName, deviceLabel, budget);
  }
  if (deviceLabel) {
    return truncate(deviceLabel, budget) || FALLBACK_PASSKEY_NAME;
  }
  if (userName) {
    return composePossessive(userName, "passkey", budget);
  }
  return FALLBACK_PASSKEY_NAME;
}

/**
 * Compose `"<userName>’s <tail>"`, shortening the USER NAME — never the tail —
 * when the two together overflow `budget`.
 *
 * Which end gets cut is a product decision, not a detail. The tail is the part
 * that carries the meaning: `derivePasskeyName` is fed app-qualified device
 * labels (`"iPhone scanner"`, `"Android scanner"`) precisely so that a shared
 * or handed-off operator device is distinguishable from someone's personal
 * phone in the web passkey list. Truncating the composed string from the right
 * — which is what a naive cap does — silently deletes the word "scanner", then
 * "iPhone", and destroys exactly the signal the label was added to carry. It
 * starts biting at a 47-character person name with a 14-character label, which
 * is a real length for a real human name.
 *
 * So: the tail and the `"’s "` separator always survive intact, and the person
 * name is what gives way. A shortened first name still identifies the human
 * (they are looking at their OWN list of passkeys); a shortened device label
 * does not identify the device.
 */
function composePossessive(
  userName: string,
  tail: string,
  budget: number,
): string {
  const separator = `${TYPOGRAPHIC_APOSTROPHE}s `;
  const room = budget - separator.length - tail.length;

  // A tail long enough to leave no room for a name degrades to the BARE tail
  // (itself capped), never to an orphaned `"’s <tail>"` with an empty name.
  // `room <= 0` is the negative-slice case; `!shortened` covers a positive but
  // tiny room that `truncate` empties out — one code unit of a name that starts
  // with an astral emoji is a lone surrogate half, which `truncate` drops.
  if (room <= 0) return truncate(tail, budget) || FALLBACK_PASSKEY_NAME;

  const shortened = truncate(userName, room);
  if (!shortened) return truncate(tail, budget) || FALLBACK_PASSKEY_NAME;

  return `${shortened}${separator}${tail}`;
}

/**
 * Append `" (n)"` while staying inside {@link PASSKEY_NAME_MAX_LENGTH}. The
 * NAME is what gives way, never the suffix — the suffix is the only thing
 * making the name distinct, so it must always survive. The width is derived
 * from the suffix rather than hardcoded, because a two-digit counter needs one
 * more character than a one-digit one.
 *
 * Recomposes from the parts rather than trimming the finished base, so the
 * suffix's characters come out of the person name for the same reason the cap's
 * do (see {@link composePossessive}) — otherwise a collision would re-introduce
 * the tail-eating bug on a name that was already at the cap.
 */
function withCollisionSuffix(
  userName: string | null,
  deviceLabel: string | null,
  counter: number,
): string {
  const suffix = ` (${counter})`;
  const budget = PASSKEY_NAME_MAX_LENGTH - suffix.length;
  return `${composeName(userName, deviceLabel, budget)}${suffix}`;
}

/**
 * Truncate to at most `max` UTF-16 code units, then trim any whitespace the
 * cut exposed. Drops a trailing lone high surrogate: slicing through a
 * surrogate pair (an emoji, an astral-plane glyph) leaves an unpaired code
 * unit, which is not valid UTF-8. Nothing rejects it — Node's UTF-8 encoder
 * substitutes U+FFFD, so `pg` would happily store a replacement character —
 * which is precisely why it has to be prevented here. (Surrogates already
 * unpaired in the INPUT are handled by {@link UNPAIRED_SURROGATE}; this guard
 * only covers the cut this function makes.)
 */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;

  const sliced = value.slice(0, max);
  const lastUnit = sliced.charCodeAt(sliced.length - 1);
  const isLoneHighSurrogate = lastUnit >= 0xd800 && lastUnit <= 0xdbff;

  return (isLoneHighSurrogate ? sliced.slice(0, -1) : sliced).trimEnd();
}
