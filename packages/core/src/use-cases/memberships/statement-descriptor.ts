/**
 * Card-statement descriptor for membership charges.
 *
 * The single cheapest dispute-prevention lever on recurring billing
 * (recurring-memberships spec, "Dispute policy" item 1): the member's card
 * statement must show the OWNER's name — the venue they knowingly support —
 * because an unrecognised descriptor is exactly how "is this fraud?"
 * chargebacks start. The tier name never fits in 22 characters and belongs in
 * the receipt email, not the statement.
 *
 * Stripe's rules for `Product.statement_descriptor` (which is where a
 * subscription charge takes its descriptor from — subscriptions have no
 * descriptor field of their own):
 *
 *  - at most 22 characters, and at least 5 (Stripe rejects shorter ones);
 *  - must not contain `<`, `>`, `\`, `'`, `"` or `*`;
 *  - must contain at least one letter (card networks reject an all-digit
 *    descriptor);
 *  - rendered on statements in capital letters, and non-ASCII characters are
 *    stripped unpredictably downstream — so we strip them ourselves rather
 *    than let a card network decide.
 *
 * Truncation strategy, in order:
 *  1. strip the disallowed characters and everything outside printable ASCII
 *     (emoji, accents — dropped, not transliterated: predictable beats clever
 *     on a field a bank re-renders);
 *  2. collapse whitespace runs and trim;
 *  3. uppercase (Stripe would anyway; doing it here makes the equality check
 *     in the adapter's heal path honest);
 *  4. truncate to 22, preferring the last complete word — a cut mid-word
 *     ("DRKMTTR COLLECTIVE NAS") reads worse than one word fewer. A single
 *     unbroken run longer than 22 is hard-cut, since there is no boundary to
 *     respect.
 *
 * Letterless fallback: a name that yields no A–Z letter after the pipeline
 * (empty, all digits, all symbols, or a truncation that ate the only lettered
 * word) keeps its recognisable fragment and appends "MEMBERSHIP" — an
 * all-digit venue called "615" becomes "615 MEMBERSHIP", which the member can
 * still place. With no fragment at all it is plain "MEMBERSHIP". The fragment
 * is pre-truncated so the suffix always fits inside 22.
 *
 * Too-short fallback: Stripe also rejects descriptors SHORTER than 5
 * characters, so a lettered name that lands under 5 ("AB") takes the same
 * suffix path — "AB MEMBERSHIP". The short name is at most 4 chars, so the
 * suffixed result (≤15) always fits inside 22.
 */

const MAX_LENGTH = 22;
const MIN_LENGTH = 5;
const FALLBACK = "MEMBERSHIP";
const DISALLOWED_CHARS = /[<>\\'"*]/g;
// eslint-disable-next-line no-control-regex -- deliberate printable-ASCII allowlist
const OUTSIDE_PRINTABLE_ASCII = /[^\x20-\x7E]/g;

export function buildStatementDescriptor(
  ownerName: string | null | undefined,
): string {
  const cleaned = (ownerName ?? "")
    // Normalise whitespace FIRST: tabs/newlines are outside printable ASCII,
    // so stripping before collapsing would weld "Basement\tEast" into
    // "BasementEast" instead of keeping the word break.
    .replace(/\s+/g, " ")
    .replace(DISALLOWED_CHARS, "")
    .replace(OUTSIDE_PRINTABLE_ASCII, "")
    // Dropping a run like " 🔥 " leaves doubled spaces — collapse again.
    .replace(/ {2,}/g, " ")
    .trim()
    .toUpperCase();

  const truncated = truncateAtWordBoundary(cleaned, MAX_LENGTH);
  if (/[A-Z]/.test(truncated)) {
    if (truncated.length >= MIN_LENGTH) return truncated;
    // Below Stripe's 5-char minimum ("AB"): brand it like the letterless
    // path. `truncated` is ≤4 chars here, so the result is ≤15 — inside 22.
    return `${truncated} ${FALLBACK}`;
  }

  // No letter survived. Keep whatever recognisable fragment exists and brand
  // the rest; `MAX_LENGTH - FALLBACK - 1` leaves room for the joining space.
  const fragment = truncateAtWordBoundary(
    cleaned,
    MAX_LENGTH - FALLBACK.length - 1,
  );
  return fragment ? `${fragment} ${FALLBACK}` : FALLBACK;
}

/**
 * First `max` characters, backing up to the last complete word when the cut
 * would land mid-word and a word boundary exists to back up to.
 */
function truncateAtWordBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const hard = value.slice(0, max);
  if (value.charAt(max) !== " ") {
    const lastSpace = hard.lastIndexOf(" ");
    if (lastSpace > 0) return hard.slice(0, lastSpace).trimEnd();
  }
  return hard.trimEnd();
}
