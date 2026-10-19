/**
 * Compose a display address from the event's location fields, without
 * repeating a component the free-form line already contains.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `Event.addressText` is NOT a street line. It is whatever the import or the
 * geocoder produced, and for the bulk-imported community listings that is the
 * WHOLE address — venue, street, city, region. It is then mapped straight into
 * the `addressLine1` slot (see `EmbedEventDetail`), and the old composition
 * appended `locality`, `region`, `postalCode` and `countryCode` after it:
 *
 *   addressText  "Springwater Supper Club & Lounge, 115 27th Ave N, Nashville, TN"
 *   + locality   "Nashville"
 *   + region     "TN"
 *   + postal     "37203"
 *   + country    "US"
 *   =            "…, 115 27th Ave N, Nashville, TN, Nashville, TN, 37203, US"
 *
 * — which is what shipped, on every surface that renders an address.
 *
 * ── HOW IT DEDUPES: WHOLE SEGMENTS, NEVER SUBSTRINGS ────────────────────────
 * A substring test would be wrong. "100 Nashville Ave, Memphis" contains
 * "nashville", so a substring rule would swallow a genuine `locality` of
 * Nashville on an address that merely has it in the street name. So the
 * accumulated text is split on commas and a candidate is dropped only when it
 * equals an entire existing segment. "100 nashville ave" is one segment and
 * never equals "nashville", so the false positive cannot occur.
 *
 * Comparison is case- and punctuation-insensitive ("St." vs "St", "Nashville"
 * vs "NASHVILLE"), because these fields come from several importers.
 *
 * ── THE POSTAL TAIL: "…, <REGION> <POSTAL>[, <COUNTRY>]" ────────────────────
 * Whole-segment matching alone misses the single most common way an address is
 * written, because the standard postal form packs the region and the code into
 * ONE comma segment and then names the country after it:
 *
 *   addressText  "Springwater, 115 27th Ave N, Nashville, TN 37203, United States of America"
 *   + region     "Tennessee"  ← "tn 37203" is not "tennessee"
 *   + postal     "37203"      ← nor is it "37203"
 *   + country    "US"         ← nor is "united states of america" "us"
 *   =            "…, TN 37203, United States of America, Tennessee, 37203, US"
 *
 * MEASURED in the community builder preview. Each of those three is the SAME
 * FACT the line already states, in the other spelling, and no amount of string
 * comparison will see that — "TN" and "Tennessee" share nothing.
 *
 * So the line is PARSED instead of only compared. A segment whose last token is
 * postal-code-shaped is the postal segment; the head before it is the region,
 * and any segment after it is the country. Finding one means the line is
 * already a complete postal address, and all three structured parts are
 * dropped as redundant — whichever spelling either side happens to use.
 *
 * The parse is deliberately conservative, because a false positive here deletes
 * real information. A head containing digits ("115 27th ave n 37203") is a
 * street, not a region, and disqualifies the segment; so does a head longer
 * than three words. And no postal-shaped token means no parse at all, which is
 * why "100 Nashville Ave" is still untouched by any of this.
 */

/** Case/punctuation/whitespace-insensitive form used ONLY for comparison. */
const normalize = (value: string): string =>
  value
    .toLowerCase()
    // Punctuation to spaces rather than nothing, so "st.paul" does not become
    // the single token "stpaul" and stop matching "st paul".
    .replace(/[.\-–—/#'"`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Postal-code shapes, deliberately narrow: US ZIP / ZIP+4 and the digit-run
 * formats most of Europe uses. Anything alphabetic is excluded — a loose rule
 * here would start splitting ordinary street segments.
 */
const POSTAL_TOKEN = /^\d{3,10}$/;

/** The comma-separated segments of an already-composed address line. */
const segmentsOf = (value: string): string[] =>
  value
    .split(",")
    .map((segment) => normalize(segment))
    .filter(Boolean);

/** Longest a region name runs ("new south wales"). Beyond this it is a street. */
const MAX_REGION_WORDS = 3;

type PostalTail = {
  /** A segment follows the postal one — that segment is the country. */
  hasCountry: boolean;
};

/**
 * Find the "<region> <postal>" segment of a free-form line, if it has one.
 * Returns null when the line is a bare street/venue line, which is the case
 * the structured parts exist to complete.
 */
function parsePostalTail(value: string): PostalTail | null {
  const segments = segmentsOf(value);
  for (let i = 0; i < segments.length; i += 1) {
    const tokens = segments[i]!.split(" ");
    if (tokens.length < 2) continue;

    const last = tokens[tokens.length - 1]!;
    if (!POSTAL_TOKEN.test(last)) continue;

    const head = tokens.slice(0, -1);
    // A street, not a region: house numbers and long runs of words.
    if (head.length > MAX_REGION_WORDS) continue;
    if (head.some((token) => /\d/.test(token))) continue;

    return { hasCountry: i < segments.length - 1 };
  }
  return null;
}

export type ComposeAddressParts = {
  /**
   * The free-form line. Frequently a complete address rather than a street
   * line — that is the whole reason this function exists.
   */
  addressText?: string | null;
  addressLine2?: string | null;
  locality?: string | null;
  region?: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
};

/**
 * Join the parts in postal order, skipping any whose value is already present
 * as a whole segment of what has been composed so far.
 *
 * Returns `undefined` when nothing at all is known, so callers can keep using
 * it as a truthiness gate for rendering the row.
 */
export function composeEventAddress(
  parts: ComposeAddressParts,
): string | undefined {
  // The free-form half, and what its own shape already states (see the header).
  const freeForm = [parts.addressText, parts.addressLine2]
    .map((value) => (value ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const postalTail = freeForm ? parsePostalTail(freeForm) : null;

  const ordered: Array<string | null | undefined> = [
    parts.addressText,
    parts.addressLine2,
    parts.locality,
    // The postal segment IS the region and the code; a segment after it is the
    // country. Spelling never has to agree for this to hold.
    postalTail ? null : parts.region,
    postalTail ? null : parts.postalCode,
    postalTail?.hasCountry ? null : parts.countryCode,
  ];

  const kept: string[] = [];
  const seen = new Set<string>();

  for (const raw of ordered) {
    const value = (raw ?? "").trim();
    if (!value) continue;

    const key = normalize(value);
    if (!key || seen.has(key)) continue;

    kept.push(value);
    // A multi-segment value (the free-form line) contributes every one of its
    // segments, which is what lets a later bare `locality` match against the
    // city buried inside it.
    for (const segment of segmentsOf(value)) seen.add(segment);
    seen.add(key);
  }

  return kept.join(", ") || undefined;
}
