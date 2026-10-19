/**
 * The human-readable PaymentIntent `description` — the string Stripe renders in
 * the Dashboard payments list, CSV exports, Sigma, and dispute evidence.
 *
 * This is NOT the statement descriptor. `buildStatementDescriptorSuffix` (the
 * sibling module) produces a 22-char, ASCII-only, uppercased string that appears
 * on the CARDHOLDER'S BANK STATEMENT and is governed by Stripe's descriptor
 * rules. This one is an INTERNAL/OPS field: we set no `receipt_email` anywhere,
 * so Stripe sends no receipts and no buyer ever sees it. It is still written to
 * be customer-safe (the order code is already customer-facing on tickets and in
 * emails), but it is optimised for whoever is scanning the Dashboard trying to
 * work out what a payment was.
 *
 * Because it is not a statement descriptor, it is UTF-8 clean: titles are NOT
 * transliterated, NOT stripped of diacritics, and NOT uppercased. A title of
 * "Café São João" survives byte for byte.
 *
 * Shape:
 *   Launch Party — 3 tickets · Order DB21B2C3
 *   Launch Party — 1 resale ticket · Order DB21B2C3
 *   Launch Party — 2 tickets · POS · Order DB21B2C3
 *
 * The order code comes from `formatOrderCode` — the ONE canonical 8-hex TAIL of
 * `Order.id`, uppercased. Never `id.slice(0, 8)`: that is the UUID HEAD, a
 * different string that still parses as valid hex in admin search and therefore
 * silently resolves to zero rows. That bug has already been shipped and fixed
 * once; importing the shared formatter is what keeps it fixed.
 *
 * Pure string work. This must never throw and never block a checkout.
 */

import { formatOrderCode } from "@th/types/order-identifier";

import { sanitizePlainText } from "../sanitize-plain-text";

/**
 * Which payment path produced this charge.
 *  - `primary` — web/app checkout for newly issued tickets.
 *  - `resale`  — a buyer purchasing a listed ticket from another human.
 *  - `pos`     — card-present sale at the door (Stripe Terminal).
 */
export type PaymentDescriptionKind = "primary" | "resale" | "pos";

/**
 * Cap for the event-title segment, INCLUSIVE of the ellipsis, so the whole
 * description stays readable in the Dashboard's description column. Stripe's
 * own limit is 1000 chars, so this is a legibility budget, not a hard bound.
 */
const MAX_TITLE_LENGTH = 80;

const ELLIPSIS = "…";
/** U+2014 EM DASH — between the title and the quantity. */
const EM_DASH = "—";
/** U+00B7 MIDDLE DOT — between segments. */
const SEGMENT_SEPARATOR = " · ";

export function buildPaymentDescription(input: {
  eventTitle: string | null | undefined;
  orderId: string;
  /**
   * TICKET lines only. Callers must exclude discount and credit lines — "3
   * tickets" has to mean three tickets. Omitted / zero / anything that is not
   * a positive integer drops the quantity segment rather than emitting
   * "0 tickets".
   */
  ticketQuantity?: number;
  kind: PaymentDescriptionKind;
}): string {
  const title = normalizeTitle(input.eventTitle);
  const quantity = describeQuantity(input.ticketQuantity, input.kind);

  // The em dash binds the title to the quantity; either half may be absent, in
  // which case the survivor stands alone rather than leading with a separator.
  const lead =
    title && quantity ? `${title} ${EM_DASH} ${quantity}` : (title ?? quantity);

  const segments = [
    lead,
    input.kind === "pos" ? "POS" : null,
    `Order ${formatOrderCode(input.orderId)}`,
  ].filter((segment): segment is string => Boolean(segment));

  return segments.join(SEGMENT_SEPARATOR);
}

/**
 * Clean an organiser-supplied title, then truncate it. Returns `null` for a
 * title that is empty once cleaned, so the caller can omit the segment.
 *
 * Cleaning is delegated to the house sanitiser (`sanitizePlainText`) rather
 * than hand-rolled here. Beyond the C0/C1 controls a bespoke regex would
 * catch, it also strips the Unicode FORMAT class (`\p{Cf}`) — bidi overrides
 * (U+202E RLO, U+2066–U+2069 isolates) and the zero-width family — which
 * matters because this string lands in dispute evidence and in a Dashboard
 * column an operator scans by eye: an organiser-controlled title must not be
 * able to visually reorder the rest of the line, order code included. It also
 * strips HTML tags with a real parser and collapses whitespace.
 *
 * Accents, CJK, and emoji BASE characters pass through untouched. ZWJ (U+200D)
 * is `\p{Cf}` and is removed, so a joined family emoji degrades to its
 * component glyphs — accepted, because event titles already went through this
 * exact sanitiser at save time (`plainTextRequired(140)`), so the degradation
 * is present in the stored value and reusing the helper changes nothing in
 * practice.
 */
function normalizeTitle(value: string | null | undefined): string | null {
  if (!value) return null;

  const cleaned = sanitizePlainText(value);
  if (!cleaned) return null;

  return truncateTitleAtWordBoundary(cleaned);
}

/**
 * Word-boundary truncate to {@link MAX_TITLE_LENGTH}, ellipsis included in the
 * budget.
 *
 * Deliberately NOT named `truncateAtWordBoundary`: the sibling
 * `statement-descriptor.ts` has a private helper by that name with different
 * semantics (no ellipsis, no ellipsis budget), and same-named-different-meaning
 * helpers have bitten this repo before.
 */
function truncateTitleAtWordBoundary(value: string): string {
  if (value.length <= MAX_TITLE_LENGTH) return value;

  // Budget one char for the ellipsis so the segment stays within the cap.
  const sliced = value.slice(0, MAX_TITLE_LENGTH - ELLIPSIS.length);
  const lastSpace = sliced.lastIndexOf(" ");
  const truncated = (lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced).trim();

  // `slice` cuts UTF-16 CODE UNITS, so a title with no space in its first 79
  // units (the ordinary case for CJK) can be cut through the middle of a
  // surrogate pair, leaving a dangling high surrogate. Drop the orphan half:
  // it renders as a replacement glyph, and any encoder stricter than the one
  // stripe-node happens to use today would throw a URIError on it — inside
  // `callOrDependencyFailed`, i.e. a blocked sale.
  const safe = endsWithHighSurrogate(truncated)
    ? truncated.slice(0, -1)
    : truncated;

  return `${safe}${ELLIPSIS}`;
}

/** True when the final UTF-16 unit is the LEADING half of a surrogate pair. */
function endsWithHighSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const lastUnit = value.charCodeAt(value.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff;
}

function describeQuantity(
  quantity: number | undefined,
  kind: PaymentDescriptionKind,
): string | null {
  if (quantity === undefined || !Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  const noun = kind === "resale" ? "resale ticket" : "ticket";
  return `${quantity} ${noun}${quantity === 1 ? "" : "s"}`;
}
