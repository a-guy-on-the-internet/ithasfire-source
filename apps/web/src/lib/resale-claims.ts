import { RESALE_CLAIM_WINDOW_DAYS } from "@th/types/repos/resale-listings";

// ─────────────────────────────────────────────────────────────────────────────
// Resale claims: the client-side rules the three claim screens share (buyer
// files, seller replies, staff decides). The server is the authority on every
// one of them; these only decide what the UI offers.
// ─────────────────────────────────────────────────────────────────────────────

export { RESALE_CLAIM_WINDOW_DAYS };

/**
 * Mirrors `CLAIM_EVIDENCE_TEXT_MAX` in
 * `@th/core/use-cases/resale/claim-evidence.ts` (the buyer's description and
 * the seller's reply share it). Not imported from there: that module pulls
 * `sanitize-html` into the client bundle through its sanitizer.
 */
export const CLAIM_TEXT_MAX = 2000;

/** `reviewClaimInputSchema.resolutionNote` is `z.string().max(2000)`. */
export const CLAIM_RESOLUTION_NOTE_MAX = 2000;

export const CLAIM_KINDS = [
  "ticket_invalid",
  "entry_denied",
  "wrong_seat",
  "other",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** Plain-language labels for the kind a buyer picks (and everyone reads). */
export const CLAIM_KIND_COPY: Record<
  ClaimKind,
  { labelKey: string; descriptionKey: string }
> = {
  ticket_invalid: {
    labelKey: "resaleClaim.kindTicketInvalid",
    descriptionKey: "resaleClaim.kindTicketInvalidDesc",
  },
  entry_denied: {
    labelKey: "resaleClaim.kindEntryDenied",
    descriptionKey: "resaleClaim.kindEntryDeniedDesc",
  },
  wrong_seat: {
    labelKey: "resaleClaim.kindWrongSeat",
    descriptionKey: "resaleClaim.kindWrongSeatDesc",
  },
  other: {
    labelKey: "resaleClaim.kindOther",
    descriptionKey: "resaleClaim.kindOtherDesc",
  },
};

export function claimKindLabelKey(kind: string): string | null {
  return (
    (CLAIM_KIND_COPY as Record<string, { labelKey: string }>)[kind]?.labelKey ??
    null
  );
}

/** Statuses on which staff can still decide and the seller can still reply. */
export function isClaimUndecided(status: string): boolean {
  return status === "open" || status === "under_review";
}

/**
 * Ticket statuses a buyer can file on. Mirrors `CLAIMABLE_TICKET_STATUSES` in
 * `@th/core/use-cases/_helpers/claimant-holds-ticket.ts`: LISTED (relisted)
 * and REFUNDED are refused there.
 */
const CLAIMABLE_TICKET_STATUSES = new Set(["VALID", "SCANNED", "INVALID"]);

export interface ClaimableTicketCandidate {
  id: string;
  status: string;
  orderItemId: string | null;
  item: {
    id: string;
    kind: string;
    status: string;
    resaleListingId: string | null;
    transferredAt: Date | string | null;
    refundedAt: Date | string | null;
  } | null;
}

/**
 * Whether this ticket is a resale purchase the viewer still holds and can
 * file on. The ORDER must be a resale order (`isResaleOrder`; callers check
 * that, `getMyOrder` carries `source`).
 *
 * `resaleListingId` stays as a per-item check, no longer a proxy for "resale
 * order": `create-claim` finds the seller (the respondent) through the item's
 * listing and refuses with "could not identify the seller" without one, so an
 * item with no listing pointer cannot be filed on.
 */
export function isClaimableResaleTicket(
  ticket: ClaimableTicketCandidate,
): boolean {
  const { item } = ticket;
  return (
    !!item &&
    !!ticket.orderItemId &&
    item.kind === "ticket" &&
    item.status === "active" &&
    !!item.resaleListingId &&
    !item.transferredAt &&
    !item.refundedAt &&
    CLAIMABLE_TICKET_STATUSES.has(ticket.status)
  );
}

/** A resale purchase: the only orders `create-claim` accepts. */
export function isResaleOrder(order: { source: string }): boolean {
  return order.source === "RESALE";
}

/**
 * Where the filing window stands, from the server's own close time
 * (`getMyOrder.resaleClaimWindowClosesAt`, the shared
 * `resaleClaimWindowClosesAt` rule: `(endsAt ?? startsAt) + 3 days`).
 * Half-open, like the server: open while `startsAt <= now < close`.
 *  - `not_open`: the event has not started.
 *  - `open`: started and before the close.
 *  - `closed`: at or past the close.
 * Returns null when either time is missing or unreadable (not a resale
 * order, or the event could not be read): offer nothing.
 */
export type ClaimWindowState = "not_open" | "open" | "closed";

export function claimWindowState(args: {
  eventStartsAt: Date | string | null;
  resaleClaimWindowClosesAt: string | null;
  now: number;
}): ClaimWindowState | null {
  if (!args.eventStartsAt || !args.resaleClaimWindowClosesAt) return null;
  const start = new Date(args.eventStartsAt).getTime();
  const close = new Date(args.resaleClaimWindowClosesAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(close)) return null;
  if (args.now < start) return "not_open";
  if (args.now < close) return "open";
  return "closed";
}

/**
 * The buyer-side sentence for each `claims.create` refusal. Anything else
 * falls through to `formatErrorMessage(err, t)` (the `errors.*` catalog).
 */
export const CREATE_CLAIM_ERROR_KEYS: Record<string, string> = {
  CLAIM_WINDOW_NOT_OPEN: "resaleClaim.errorWindowNotOpen",
  CLAIM_WINDOW_EXPIRED: "resaleClaim.errorWindowExpired",
  CLAIM_ALREADY_EXISTS: "resaleClaim.errorAlreadyExists",
  CLAIM_TICKET_NOT_HELD: "resaleClaim.errorTicketNotHeld",
  CLAIM_NOT_RESALE_ORDER: "resaleClaim.errorNotResale",
};

/**
 * The first 8 characters of a claim id: enough to tell open panels apart in
 * accessible names ("Deny claim Wrong seat 3f2a9c1d") without the "…" that
 * `truncateId` adds for display.
 */
export function claimShortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Staff-side sentences for `claims.review` refusals that the shared `errors.*`
 * catalog does not carry. REFUND_FAILED and REFUND_REJECTED are INTERNAL codes
 * (`@th/errors`), whose `errors.*` keys must stay out of the catalog
 * (`error-code-parity.test.ts`), so the claim desk words them here.
 * CLAIM_ALREADY_RESOLVED gets the "someone else decided" reading: on the desk
 * that is the only way it happens.
 */
export const REVIEW_CLAIM_ERROR_KEYS: Record<string, string> = {
  REFUND_FAILED: "resaleClaim.staffErrorRefundFailed",
  REFUND_REJECTED: "resaleClaim.staffErrorRefundRejected",
  CLAIM_ALREADY_RESOLVED: "resaleClaim.staffDecidedElsewhere",
};

/**
 * Whether an approved claim's refund is confirmed (`refundConfirmed`: the
 * claim's order is REFUNDED). The claim is committed `approved` BEFORE Stripe
 * runs, so an approved claim alone never proves the money moved.
 */
export function isRefundPending(claim: {
  status: string;
  refundConfirmed: boolean;
}): boolean {
  return claim.status === "approved" && !claim.refundConfirmed;
}

/**
 * Catalog key for a claim's outcome in a table's Resolution column, read from
 * the status and `refundConfirmed` (never the raw `resolution` string, which
 * is a code like `full_refund`). Null while undecided.
 */
export function claimResolutionKey(claim: {
  status: string;
  refundConfirmed: boolean;
}): string | null {
  if (claim.status === "approved") {
    return claim.refundConfirmed
      ? "resaleClaim.resolutionFullRefund"
      : "resaleClaim.resolutionRefundPending";
  }
  if (claim.status === "denied") return "resaleClaim.resolutionNoRefund";
  if (claim.status === "expired") return "resaleClaim.resolutionClosed";
  return null;
}
