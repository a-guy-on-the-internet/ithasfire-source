import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { fail, isAppError } from "@th/errors";

import {
  cancelEventForBooking,
  type CancelEventDeps,
} from "../../events/cancel-event";

import {
  failBookingCancelled,
  isBookingCancelled,
} from "../../booking-holds/_shared/booking-night";

// ─────────────────────────────────────────────────────────────────────────────
// EXITS AFTER ACCEPT (booking-the-night N14 / FR-010). An ACCEPTED request
// has exits until its night is booked: the sender Withdraws, the venue Closes
// it with a reason. Both release the request's holds and cancel its draft
// terms; once the night is booked the one undo is Cancel booking (N13).
//
// Both run inside the closing transaction, AFTER the request's booking lock
// (`bookingHolds.lockRequestBooking`) — the lock every take, Cancel booking
// and hold placement also takes first. So the "is the night booked?" read
// below sees any take that committed before us, and a take that comes after
// waits, then reads the request closed (`takeRequestNightInTx` /
// book-without-terms refuse a request that is not ACCEPTED).
// ─────────────────────────────────────────────────────────────────────────────

/** Agreement statuses an exit cancels; anything else is already terminal. */
const EXIT_CANCELLABLE_AGREEMENT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "COUNTERED",
  "ACCEPTED",
] as const;

/**
 * Refuse an exit from an ACCEPTED request whose booking has gone further,
 * reading under the request's booking lock (the caller took it):
 *   - BOOKING_CANCELLED — the booking was cancelled; the request stays
 *     ACCEPTED as history and is not reopened or closed again;
 *   - BOOKING_NIGHT_BOOKED — a CONFIRMED hold: the night is booked, and the
 *     undo is Cancel booking (no meta, either side);
 *   - AGREEMENT_FINALIZED — the terms are finalized against an event (money
 *     settles on them; an exit never cancels finalized terms).
 * Returns the request's terms (null when it has none) for
 * {@link cancelExitTermsInTx}.
 */
export async function assertAcceptedRequestCanExitInTx(
  tx: TxRepos,
  request: Pick<BookingRequestRecord, "id" | "agreementId">,
): Promise<AgreementRecord | null> {
  const holds = await tx.bookingHolds.listForRequest(request.id);
  if (isBookingCancelled(holds)) {
    failBookingCancelled();
  }
  if (holds.some((h) => h.status === "CONFIRMED")) {
    throw fail("BOOKING_NIGHT_BOOKED");
  }
  const agreement = request.agreementId
    ? await tx.agreements.getById(request.agreementId)
    : null;
  if (agreement?.eventId) {
    throw fail("AGREEMENT_FINALIZED");
  }
  return agreement;
}

/**
 * Under the request's booking lock, BEFORE an exit writes anything: a request
 * whose night is booked (any CONFIRMED hold) cannot be withdrawn or declined —
 * BOOKING_NIGHT_BOOKED, whose copy points at Cancel booking. Both exits share
 * it so the two sides of one request can never disagree about that state.
 */
export async function assertNoBookedNightInTx(
  tx: TxRepos,
  bookingRequestId: string,
): Promise<void> {
  const holds = await tx.bookingHolds.listForRequest(bookingRequestId);
  if (holds.some((h) => h.status === "CONFIRMED")) {
    throw fail("BOOKING_NIGHT_BOOKED");
  }
}

/**
 * Defence in depth (review W1), AFTER the exit released the request's live
 * holds — so after it holds their lines' locks: if any of the request's holds
 * is CONFIRMED now, something booked the night between the exit's first read
 * and these locks (a publish-time settle that did not serialize on the
 * booking lock, in an older build or a future caller). Refuse; the whole
 * exit rolls back and the night stays booked — never a WITHDRAWN / DECLINED
 * request holding a CONFIRMED hold nobody can free.
 */
export async function assertNoBookedNightAfterReleaseInTx(
  tx: TxRepos,
  bookingRequestId: string,
): Promise<void> {
  const holds = await tx.bookingHolds.listForRequest(bookingRequestId);
  if (holds.some((h) => h.status === "CONFIRMED")) {
    throw fail("BOOKING_NIGHT_BOOKED");
  }
}

/**
 * The exit's draft terms → CANCELLED, in the closing transaction. A no-op on
 * terms already terminal. The CAS also requires `eventId` still NULL, so a
 * finalize racing the exit loses one way or the other — never both.
 * Returns the cancelled terms' id, or null when nothing was cancelled.
 */
export async function cancelExitTermsInTx(
  tx: TxRepos,
  args: {
    agreement: AgreementRecord | null;
    bookingRequestId: string;
    actorHumanId: string;
    via: "withdraw" | "close_request";
    reason: string | null;
    now: Date;
  },
): Promise<string | null> {
  const { agreement } = args;
  if (
    !agreement ||
    !(EXIT_CANCELLABLE_AGREEMENT_STATUSES as readonly string[]).includes(
      agreement.status,
    )
  ) {
    return null;
  }
  try {
    await tx.agreements.updateStatus({
      id: agreement.id,
      status: "CANCELLED",
      expectedFrom: EXIT_CANCELLABLE_AGREEMENT_STATUSES,
      expectEventIdNull: true,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "conflict" &&
      (error as { message?: unknown }).message === "agreement_status_changed"
    ) {
      // The terms moved under us (finalized, or answered): the whole exit
      // rolls back; the caller retries from a fresh read.
      throw fail("INVALID_STATUS", {
        message: "agreement_status_changed",
        meta: { agreementId: agreement.id },
      });
    }
    throw error;
  }
  await tx.audit.log({
    entity: "booking_agreement",
    entityId: agreement.id,
    action: "booking_agreement.cancelled",
    data: {
      actorHumanId: args.actorHumanId,
      fromStatus: agreement.status,
      via: args.via,
      bookingRequestId: args.bookingRequestId,
      ...(args.reason ? { reason: args.reason } : {}),
    },
    at: args.now,
  });
  return agreement.id;
}

// ─────────────────────────────────────────────────────────────────────────────
// The request's still-DRAFT event ends with it (review round 1, nit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The request's minted event that an exit cancels with it: the terms' draft
 * anchor, while the terms are not finalized, when it is not the event-first
 * origin (the requester's own event, built before the request — never
 * cancelled by an exit) and the event is still a DRAFT. A DRAFT sells
 * nothing, so cancelling it refunds nothing. Null otherwise. A PUBLISHED
 * anchor with no booked night (a legacy date-less mint the venue published)
 * is left as it was — see the P2c report's follow-ups.
 */
export async function exitDraftEventIdOf(
  repos: Pick<Repos, "events"> | Pick<TxRepos, "events">,
  agreement: Pick<AgreementRecord, "eventId" | "draftEventId"> | null,
  request: Pick<BookingRequestRecord, "originEventId">,
): Promise<string | null> {
  const draftEventId = agreement?.draftEventId ?? null;
  if (!agreement || agreement.eventId !== null || !draftEventId) return null;
  if (draftEventId === request.originEventId) return null;
  const event = await repos.events.getById(draftEventId);
  return event?.status === "DRAFT" ? draftEventId : null;
}

/**
 * Under the exit's locks: the draft the pre-flight chose to cancel (null =
 * none) must still be the only one. In the event path that draft is already
 * CANCELLED in this transaction, so any live DRAFT anchor now is one that
 * appeared since (a mint racing the exit) — HOLD_LINE_CHANGED, retryable,
 * nothing written: the retry cancels it.
 */
export async function assertNoNewExitDraftInTx(
  tx: TxRepos,
  agreement: AgreementRecord | null,
  request: Pick<BookingRequestRecord, "id" | "originEventId">,
): Promise<void> {
  const draft = await exitDraftEventIdOf(tx, agreement, request);
  if (draft) {
    throw fail("HOLD_LINE_CHANGED", {
      message: "booking_event_appeared",
      meta: { bookingRequestId: request.id },
    });
  }
}

/** What an exit needs to cancel the request's DRAFT event (cancelEvent's ports). */
export type ExitEventCancellationDeps = Pick<
  CancelEventDeps,
  "payments" | "idempotency" | "authz" | "search"
>;

/**
 * Run an exit's transaction body INSIDE the cancellation of the request's
 * DRAFT event (`cancelEventForBooking`, audit `via: booking_exit`), so the
 * request's close and its event's CANCELLED commit together: an exit never
 * leaves the request closed with its event live, nor the event cancelled on
 * a request still open. The event's own cancel rules apply unchanged
 * (media, quota, search, the change-notice outbox; no orders on a DRAFT).
 *
 *   - the draft is no longer cancellable when cancelEvent reads it
 *     (EVENT_ALREADY_CANCELLED / EVENT_NOT_CANCELLABLE) → the body runs in
 *     its own transaction (`plain`). cancelEvent PINS an exit to a DRAFT, at
 *     load and again under the event row lock (review round 2, W2): an anchor
 *     that was PUBLISHED meanwhile is refused there with EVENT_NOT_CANCELLABLE
 *     — nothing cancelled, nothing refunded — and this fallback then closes
 *     the request and leaves that live event exactly as it is (the same
 *     outcome as an anchor published before the exit's first read: the
 *     published-legacy-anchor follow-up, never a cancellation of it);
 *   - cancelEvent REPLAYS an earlier exit's committed record (same key: the
 *     body ran then) → `plain` too, which re-reads the request and answers
 *     as the exit's own idempotency rules say.
 */
export async function runExitWithDraftCancel<T>(
  deps: { repos: Repos; clock: CancelEventDeps["clock"]; logger?: CancelEventDeps["logger"]; reportError?: CancelEventDeps["reportError"] },
  cancellation: ExitEventCancellationDeps | undefined,
  args: {
    bookingRequestId: string;
    draftEventId: string;
    actorHumanId: string;
    body: (tx: TxRepos) => Promise<T>;
  },
): Promise<T> {
  const plain = () => deps.repos.tx(args.body);
  if (!cancellation) {
    // Composition-root wiring error: refuse rather than strand the draft.
    throw fail("NOT_CONFIGURED", {
      message: "exit_event_cancellation_not_wired",
      meta: { bookingRequestId: args.bookingRequestId },
    });
  }
  let out: { value: T } | null = null;
  try {
    await cancelEventForBooking(
      { ...deps, ...cancellation },
      {
        actorHumanId: args.actorHumanId,
        eventId: args.draftEventId,
        idempotencyKey: `bookingRequest:exit:${args.bookingRequestId}:${args.draftEventId}`,
        auditVia: "booking_exit",
        withinTx: async (tx) => {
          out = { value: await args.body(tx) };
        },
      },
    );
  } catch (error) {
    if (
      isAppError(error) &&
      (error.code === "EVENT_ALREADY_CANCELLED" ||
        error.code === "EVENT_NOT_CANCELLABLE")
    ) {
      return plain();
    }
    throw error;
  }
  const ran = out as { value: T } | null;
  return ran ? ran.value : plain();
}

