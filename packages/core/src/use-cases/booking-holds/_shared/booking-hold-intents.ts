import { z } from "zod";

import { AppError, isAppError } from "@th/errors";

import type { BookingHoldReleaseReason } from "@th/ports/repos/booking-holds";

// ─────────────────────────────────────────────────────────────────────────────
// Notification INTENTS (booking-holds spec FR-002..FR-010, FR-016).
//
// Step 2 (core) does not send anything. Every hold transition returns the
// notifications it OWES as data — computed inside the transaction from the
// rows it actually wrote, never guessed — and step 3 (transport) turns them
// into notify() calls with the `{holdId}:{transition}:{recipient}`
// idempotency keys FR-016 mandates. Keeping the intents as data is what makes
// them testable without a mailer and keeps the routing rule (assignee → else
// placedBy → else every edit-role member) in exactly one place downstream.
//
// AUDIENCE, not recipient: `act` means "the request's performer side" and
// `staff` means "the venue side of that request" — the concrete humans are
// resolved by step 3 from `staff` (below) and the request's owner pair.
// ─────────────────────────────────────────────────────────────────────────────

export const BOOKING_HOLD_INTENT_KINDS = [
  /** A hold was placed for the act: date + position (FR-002). */
  "hold.placed",
  /**
   * SEVERAL holds were placed for the act in ONE staff action (FR-002,
   * batch) — a DIGEST, so three dates are one email and one push rather than
   * three of each. Carries every (date, position) it covers plus the hold ids
   * the digest is built from (the idempotency key hashes them, so a retry of
   * the same batch cannot double-send). Emitted ONLY for 2+ holds; a
   * single-date batch emits plain `hold.placed` so that copy is unchanged.
   */
  "hold.placed_batch",
  /** The act's position in the line changed (FR-003, move-ups after a release). */
  "hold.position_changed",
  /**
   * A challenge was opened (FR-004). Emitted to the CHALLENGED act
   * (`position: 1`, with `respondBy`), to the act at position 2 (`position:
   * 2`, "you'll hear by <respondBy>"), and to `staff` (the assignee).
   */
  "hold.challenged",
  /** The challenge deadline moved later (FR-005): challenged act + position 2. */
  "hold.challenge_extended",
  /** The challenged act kept the hold (FR-006): staff (email) + position 2. */
  "hold.kept",
  /**
   * The hold was released (FR-006 manual by the act → staff; staff manual or
   * sibling-of-confirm → act). `reason` says which.
   */
  "hold.released",
  /** The hold was confirmed — the winning act (FR-008). */
  "hold.confirmed",
  /** A competing hold on the same date was confirmed — the losing act (FR-008). */
  "hold.lost_date",
  /** A CHALLENGED hold's deadline passed (FR-007): act + staff (email). */
  "hold.expired",
] as const;

export type BookingHoldIntentKind = (typeof BOOKING_HOLD_INTENT_KINDS)[number];

export type BookingHoldIntentAudience = "act" | "staff";

export type BookingHoldNotificationIntent = {
  kind: BookingHoldIntentKind;
  bookingRequestId: string;
  holdId: string;
  audience: BookingHoldIntentAudience;
  /** ISO `YYYY-MM-DD`, place-local — the hold's date. */
  date: string;
  /** The act's (new) 1-based position, when the copy names one. */
  position?: number;
  /**
   * `hold.placed_batch` ONLY: every date the digest covers with the act's
   * position on it, ascending by date. The act's OWN dates and positions —
   * never another act's (FR-013).
   */
  dates?: Array<{ date: string; position: number }>;
  /**
   * `hold.placed_batch` ONLY: the ids of the holds this digest covers. Not
   * copy — the idempotency key is a hash over this SET (sorted), so the same
   * batch dispatched twice claims the same key. `holdId` above stays the
   * first of them, for the fingerprint/metadata/collapse key.
   */
  holdIds?: string[];
  /** Keep-or-release deadline, when the copy names one. */
  respondBy?: Date;
  /** Why the hold left its line, on `hold.released`. */
  reason?: BookingHoldReleaseReason;
  // ── booking-the-night P2d-2 ──
  /**
   * `hold.challenged` to the CHALLENGED act only (N19 / FR-014): what Keep
   * will do — agree the sent terms and book (`book_now`) or ask the venue for
   * terms (`ask_for_terms`). The act's own request's terms; names no one.
   */
  keepWill?: "book_now" | "ask_for_terms";
  /**
   * `hold.kept` to STAFF only (FR-014): the act kept the hold with no terms
   * sent — "send terms to keep this night"; `respondBy` is the act's new
   * deadline to agree them.
   */
  awaitingTerms?: boolean;
  /**
   * Routing hint for `audience: "staff"` intents ONLY — the request's
   * assignee and the hold's placer, read off the rows inside the tx so step 3
   * can apply FR-016 (assignee → placedBy → every edit-role member) without a
   * second read. Absent on `act` intents.
   */
  staff?: {
    assigneeHumanId: string | null;
    placedByHumanId: string;
  };
};

/**
 * Who to route STAFF notifications to for the PRIMARY request of a use case
 * (FR-016). `orgId` is the owning org when the venue is org-owned (null for a
 * directly human-owned venue, where the owner is implicitly the assignee).
 */
export type BookingHoldStaffRecipientHint = {
  assigneeHumanId: string | null;
  placedByHumanId: string;
  orgId: string | null;
  placeId: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Output schemas — the intents ride every hold use case's output.
// ─────────────────────────────────────────────────────────────────────────────

export const bookingHoldReleaseReasonSchema = z.enum([
  "MANUAL",
  "EXPIRED",
  "CONFIRMED_OTHER",
  "REQUEST_CLOSED",
  "SIBLING_CONFIRMED",
  "PAST_DATE",
  "EVENT_SCHEDULED",
  // booking-the-night FR-009. No path emits an intent with it yet.
  "BOOKING_CANCELLED",
  // holds-without-a-request FR-003 / FR-004 (BOOKER holds only). No path
  // emits an intent with it yet.
  "GRANT_ENDED",
]);

export const bookingHoldNotificationIntentSchema = z
  .object({
    kind: z.enum(BOOKING_HOLD_INTENT_KINDS),
    bookingRequestId: z.uuid(),
    holdId: z.uuid(),
    audience: z.enum(["act", "staff"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    position: z.number().int().min(1).optional(),
    dates: z
      .array(
        z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            position: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    holdIds: z.array(z.uuid()).min(1).optional(),
    respondBy: z.date().optional(),
    reason: bookingHoldReleaseReasonSchema.optional(),
    // ── booking-the-night P2d-2 ──
    keepWill: z.enum(["book_now", "ask_for_terms"]).optional(),
    awaitingTerms: z.boolean().optional(),
    staff: z
      .object({
        assigneeHumanId: z.uuid().nullable(),
        placedByHumanId: z.uuid(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const bookingHoldStaffRecipientHintSchema = z
  .object({
    assigneeHumanId: z.uuid().nullable(),
    placedByHumanId: z.uuid(),
    orgId: z.uuid().nullable(),
    placeId: z.uuid(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────────────
// Committed intents on a thrown error (booking-the-night review W6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notices a COMMITTED hold transaction owes, carried out on an error thrown
 * AFTER the commit (a post-commit mint that failed). The transport dispatches
 * them before mapping the error, so the act who lost the date and the sender
 * are told even though the call as a whole failed.
 */
export type CommittedHoldIntents = {
  notificationIntents: BookingHoldNotificationIntent[];
  staffRecipientHint: BookingHoldStaffRecipientHint;
  bookingRequestId: string;
};

const COMMITTED_HOLD_INTENTS = Symbol.for("th.bookingHolds.committedIntents");

/**
 * The error to rethrow after a commit, carrying `committed` (a non-enumerable
 * symbol property, so it never reaches a log line or the wire). Nothing owed
 * → the error unchanged.
 *
 * Always a FRESH carrier, never the thrown object itself (which may be
 * frozen or shared): defining the property can then never fail, so there is
 * no swallow here. The carrier keeps what `toTrpcError` reads —
 *   - an AppError → a new AppError with the same code, message, meta and
 *     category, its `cause` the original (whose own cause stays reachable);
 *   - any other Error → a new Error with the same name and message and the
 *     original's own enumerable fields (a legacy `code` / `meta` / `issues`),
 *     `cause` = the original (Sentry's linked errors walk it);
 *   - a plain object (legacy `{ code, message, meta }`) → a shallow copy;
 *   - anything else → an Error describing it.
 */
export function withCommittedHoldIntents(
  error: unknown,
  committed: CommittedHoldIntents,
): unknown {
  if (committed.notificationIntents.length === 0) return error;
  const carrier = freshCarrier(error);
  Object.defineProperty(carrier, COMMITTED_HOLD_INTENTS, {
    value: committed,
    enumerable: false,
    configurable: true,
  });
  return carrier;
}

function freshCarrier(error: unknown): object {
  if (isAppError(error)) {
    return new AppError(error.code, {
      message: error.message,
      meta: error.meta,
      category: error.category,
      // The original stays in the chain; its own cause is reachable through it.
      cause: error,
    });
  }
  if (error instanceof Error) {
    const copy = Object.assign(new Error(error.message, { cause: error }), {
      ...error,
    });
    copy.name = error.name;
    return copy;
  }
  if (typeof error === "object" && error !== null) {
    return { ...error };
  }
  return new Error(String(error));
}

/** The committed intents an error carries, or null. */
export function committedHoldIntentsOf(
  error: unknown,
): CommittedHoldIntents | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<symbol, unknown>)[COMMITTED_HOLD_INTENTS];
  return value ? (value as CommittedHoldIntents) : null;
}
