import type { TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import { LIVE_BOOKING_HOLD_STATUSES } from "@th/ports/repos/booking-holds";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { BookingThreadSide } from "@th/types/repos/booking-request-messages";
import { fail } from "@th/errors";

import { normalizeThreadSide } from "../../../lib/legacy-place-values";

import { appendBookingSystemEntry } from "../../booking-requests/messages/_shared/system-entries";
import type { BookingHoldNotificationIntent } from "./booking-hold-intents";
import {
  assertBookingEventOnNight,
  assessNight,
  failBookingAlreadyHasNight,
  failBookingCancelled,
  failNightTaken,
  isBookingCancelled,
  otherBookedNight,
  resolveBookingEvent,
} from "./booking-night";
import {
  assertLineSetCovered,
  lineKeysOf,
  lockLines,
  type HoldLineKey,
} from "./hold-line";
import { settleLine } from "./settle-lapsed-holds";
import { takeLine } from "./take-line";

// ─────────────────────────────────────────────────────────────────────────────
// Booking a request's NIGHT, in the caller's transaction — the one body behind
// "Agree & book" (booking-the-night FR-001; N1, N5, N6, N17) and the venue's
// manual "Create event" on agreed terms with no booked night (NFR-001).
//
//   lock     the request's booking lock, then the night's line + every line
//            this request holds a live hold on, in the global sorted order
//            (hold-line.ts); re-read the
//            request's holds and give up (HOLD_LINE_CHANGED) if a new line
//            appeared.
//   re-read  the request and its terms under the locks; the caller's own
//            checks run here (`underLock`: the agree's PROPOSED / unchanged
//            terms).
//   refuse   — BEFORE anything on the line moves, in this order:
//            0. BOOKING_CANCELLED — the request's booking was cancelled
//               (Cancel booking, FR-009): it is never booked again;
//            1. BOOKING_ALREADY_HAS_NIGHT — this request has a CONFIRMED hold
//               on another line (one booked night per request; takeLine only
//               releases LIVE siblings, so a second take would leave two);
//            2. the request's event (`resolveBookingEvent`, spec N11): a
//               cancelled / archived / missing event-first origin, or a
//               finalized link to a dead event, refuses ALWAYS (sender:
//               EVENT_FIRST_ORIGIN_GONE / LINKED_EVENT_NOT_LIVE, no meta;
//               venue: INVALID_STATUS with the event); a live one on another
//               day than the night refuses (sender: EVENT_ON_ANOTHER_NIGHT;
//               venue: HOLD_DATE_MISMATCHES_EVENT);
//            3. N6 — another party's hold is ahead, or another party has
//               booked the night — sender: NIGHT_NO_LONGER_AVAILABLE (no
//               meta); venue: NIGHT_TAKEN (the hold to challenge).
//   commit   the caller's last write before the take (`beforeTake`: the
//            agree's PROPOSED → ACCEPTED CAS — a loser rolls everything back
//            having written nothing);
//   take     N5: this request's hold is confirmed, or a CONFIRMED hold is
//            written when it holds nothing there; N17: its other live holds
//            go SIBLING_CONFIRMED and everyone behind loses the date
//            (CONFIRMED_OTHER → lost_date) — all through the shared
//            `takeLine`.
//
// A refusal throws, so the transaction writes nothing. Ledger entries for the
// booking itself (`booking_hold.confirmed`, `booking_agreement.accepted`) and
// the audit rows stay with the callers, which know what happened; the
// losers' entries are written by `takeLine` and signed by the VENUE human
// (`venueActorHumanId`), never the sender — an act must not learn who else
// was in line (booking-holds FR-013). A hold this body writes is placed by a
// venue human (`placedByHumanId`), never by the act.
// ─────────────────────────────────────────────────────────────────────────────

export type TakeRequestNightArgs = {
  bookingRequestId: string;
  /** The request's terms (for the event check). Null = none yet. */
  agreementId: string | null;
  /** The night's line: calendar + place-local day. */
  key: HoldLineKey;
  placeTz: string;
  now: Date;
  /** Whose refusal codes: the sender's (no meta) or the venue's. */
  side: "sender" | "venue";
  /**
   * Signs the losers' entries on OTHER threads — always a venue human or
   * nobody. Null = the terms' recorded sender (`sentForReviewByHumanId`,
   * read under the locks), else nobody.
   */
  venueActorHumanId: string | null;
  /** The venue human a hold written here is placed by (never the act). */
  placedByHumanId: string;
  /** The caller's re-checks under the locks, before any refusal below. */
  underLock?: (fresh: {
    request: BookingRequestRecord;
    agreement: AgreementRecord | null;
  }) => void;
  /** The caller's last write before the line moves (e.g. the agree's CAS). */
  beforeTake?: () => Promise<void>;
};

export type TakeRequestNightResult = {
  /** This request's CONFIRMED hold on the night. */
  hold: BookingHoldRecord;
  /** True when the night had no hold of this request and one was written. */
  holdCreated: boolean;
  /** True when this request had ALREADY booked the night (no line write). */
  alreadyBooked: boolean;
  released: BookingHoldRecord[];
  intents: BookingHoldNotificationIntent[];
};

const isLive = (hold: Pick<BookingHoldRecord, "status">) =>
  (LIVE_BOOKING_HOLD_STATUSES as readonly string[]).includes(hold.status);

export async function takeRequestNightInTx(
  tx: TxRepos,
  args: TakeRequestNightArgs,
): Promise<TakeRequestNightResult> {
  const { key, now } = args;

  // ── Lock ───────────────────────────────────────────────────────────────────
  // The request's booking lock FIRST (before any line lock — the global
  // order): Cancel booking, Withdraw, Close request and hold placement take
  // it too, so none of them can decide on a pre-commit view of this take.
  await tx.bookingHolds.lockRequestBooking(args.bookingRequestId);
  const lockedKeys = lineKeysOf([
    key,
    ...(await tx.bookingHolds.listForRequest(args.bookingRequestId)).filter(
      isLive,
    ),
  ]);
  await lockLines(tx, lockedKeys);
  const requestHolds = await tx.bookingHolds.listForRequest(
    args.bookingRequestId,
  );
  assertLineSetCovered(lockedKeys, requestHolds.filter(isLive));

  // ── Re-read under the locks ────────────────────────────────────────────────
  const request = await tx.bookingRequests.getById(args.bookingRequestId);
  if (!request || request.status !== "ACCEPTED") {
    throw args.side === "sender"
      ? fail("INVALID_STATUS", { message: "booking_request_closed" })
      : fail("INVALID_STATUS", {
          message: "booking_request_closed",
          meta: {
            bookingRequestId: args.bookingRequestId,
            status: request?.status ?? null,
          },
        });
  }
  const agreement = args.agreementId
    ? await tx.agreements.getById(args.agreementId)
    : null;
  args.underLock?.({ request, agreement });

  // ── Refusals, before the line moves ────────────────────────────────────────
  // 0. A cancelled booking is never booked again (FR-009, N13).
  if (isBookingCancelled(requestHolds)) {
    failBookingCancelled();
  }
  // 1. One booked night per request.
  if (otherBookedNight(requestHolds, key)) {
    failBookingAlreadyHasNight();
  }
  // 2. The request's event: live, and on this night.
  const resolved = await resolveBookingEvent(tx, { agreement, request });
  assertBookingEventOnNight(resolved, {
    night: key.date,
    placeTz: args.placeTz,
    side: args.side,
    agreementId: agreement?.id ?? null,
    calendarId: key.calendarId,
  });
  // 3. N6.
  const { line, intents: settleIntents } = await settleLine(tx, {
    ...key,
    now,
    placeTz: args.placeTz,
  });
  const confirmed = await tx.bookingHolds.listLine({
    ...key,
    statuses: ["CONFIRMED"],
  });
  const night = assessNight({
    line,
    confirmed,
    bookingRequestId: args.bookingRequestId,
  });
  if (night.kind === "taken") {
    if (args.side === "sender") {
      throw fail("NIGHT_NO_LONGER_AVAILABLE");
    }
    failNightTaken(night, key.date);
  }

  await args.beforeTake?.();

  // ── Take the line ──────────────────────────────────────────────────────────
  if (night.ownHold?.status === "CONFIRMED") {
    // Booked already (e.g. the venue booked it without terms first): the
    // line and the siblings were settled then.
    return {
      hold: night.ownHold,
      holdCreated: false,
      alreadyBooked: true,
      released: [],
      intents: settleIntents,
    };
  }
  let winner = night.ownHold;
  let winnerLine: readonly BookingHoldRecord[] = line;
  let holdCreated = false;
  if (!winner) {
    // N5: nobody holds the night (a free night has no other live hold, so
    // the line is empty) — write the hold the night is booked on.
    winner = await tx.bookingHolds.create({
      bookingRequestId: args.bookingRequestId,
      calendarId: key.calendarId,
      spaceId: null,
      date: key.date,
      position: line.length + 1,
      placedByHumanId: args.placedByHumanId,
    });
    holdCreated = true;
    winnerLine = [...line, winner];
  }
  const taken = await takeLine(tx, {
    key,
    line: winnerLine,
    winner: { hold: winner, requestHolds },
    now,
    actorHumanId:
      args.venueActorHumanId ?? agreement?.sentForReviewByHumanId ?? null,
  });
  if (!taken.confirmed) {
    // takeLine always confirms when handed a winner.
    throw new Error("take_line_without_confirmed_winner");
  }
  return {
    hold: taken.confirmed,
    holdCreated,
    alreadyBooked: false,
    released: taken.released,
    intents: [...settleIntents, ...taken.intents],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agree & book (FR-001): the sender's accept of request-linked TO_VENUE terms
// ─────────────────────────────────────────────────────────────────────────────

export type TakeNightForTermsArgs = {
  agreementId: string;
  bookingRequestId: string;
  /**
   * The `proposedDate` the caller derived `key.date` from — the date the
   * sender saw. The terms are frozen while PROPOSED, but a pull-back → edit
   * → resend between that read and these locks would move them; then the
   * call gives up (TERMS_CHANGED_SINCE_VIEWED).
   */
  expectedProposedDate: Date;
  key: HoldLineKey;
  placeTz: string;
  now: Date;
  /** The sender who tapped "Agree & book". */
  actorHumanId: string;
  /** Which side of the thread that sender is (for the accepted entry). */
  actorSide: BookingThreadSide;
  /** The venue human a hold written for the night is placed by. */
  placedByHumanId: string;
};

export type TakeNightForTermsResult = TakeRequestNightResult & {
  agreement: AgreementRecord;
};

export async function takeNightForTermsInTx(
  tx: TxRepos,
  args: TakeNightForTermsArgs,
): Promise<TakeNightForTermsResult> {
  const { now } = args;
  let accepted: AgreementRecord | null = null;

  const booked = await takeRequestNightInTx(tx, {
    bookingRequestId: args.bookingRequestId,
    agreementId: args.agreementId,
    key: args.key,
    placeTz: args.placeTz,
    now,
    side: "sender",
    // The terms' sender signs the losers' entries (read under the locks).
    venueActorHumanId: null,
    placedByHumanId: args.placedByHumanId,
    underLock: ({ agreement }) => {
      if (!agreement || agreement.status !== "PROPOSED") {
        throw fail("AGREEMENT_NOT_PROPOSED");
      }
      if (
        agreement.proposedDate?.getTime() !==
        args.expectedProposedDate.getTime()
      ) {
        // The terms moved since the sender read them: the locks are on the
        // wrong night, and what they would agree is not what they saw.
        throw fail("TERMS_CHANGED_SINCE_VIEWED");
      }
    },
    beforeTake: async () => {
      // PROPOSED → ACCEPTED, before the line moves: a concurrent pull-back
      // or second agree loses here and nothing is taken.
      accepted = await tx.agreements.updateStatus({
        id: args.agreementId,
        status: "ACCEPTED",
        expectedFrom: ["PROPOSED"],
        acceptedAt: now,
      });
    },
  });
  if (!accepted) {
    // `beforeTake` always runs when the take does.
    throw new Error("agree_without_accepted_terms");
  }
  const agreement: AgreementRecord = accepted;

  // ── Ledger + audit ─────────────────────────────────────────────────────────
  await appendBookingSystemEntry(tx, {
    bookingRequestId: args.bookingRequestId,
    kind: "booking_agreement.accepted",
    data: { agreementId: agreement.id, actorSide: args.actorSide },
    actorHumanId: args.actorHumanId,
  });
  if (!booked.alreadyBooked) {
    await appendBookingSystemEntry(tx, {
      bookingRequestId: args.bookingRequestId,
      kind: "booking_hold.confirmed",
      data: { holdId: booked.hold.id, eventId: null },
      actorHumanId: args.actorHumanId,
    });
  }
  await tx.audit.log({
    entity: "booking_agreement",
    entityId: agreement.id,
    action: "booking_agreement.accepted",
    data: {
      actorHumanId: args.actorHumanId,
      // AuditLog.data spells the place side the new way (legacy-place-values).
      actorSide: normalizeThreadSide(args.actorSide),
      bookingRequestId: args.bookingRequestId,
      night: args.key,
      holdId: booked.hold.id,
      holdCreated: booked.holdCreated,
      alreadyBooked: booked.alreadyBooked,
    },
    at: now,
  });
  if (!booked.alreadyBooked) {
    await tx.audit.log({
      entity: "booking_hold",
      entityId: booked.hold.id,
      action: "booking_hold.confirmed",
      data: {
        actorHumanId: args.actorHumanId,
        via: "agreement_accepted",
        agreementId: agreement.id,
        bookingRequestId: args.bookingRequestId,
        calendarId: booked.hold.calendarId,
        date: booked.hold.date,
        position: booked.hold.position,
        holdCreated: booked.holdCreated,
        releasedHoldIds: booked.released.map((h) => h.id),
      },
      at: now,
    });
  }

  return { ...booked, agreement };
}
