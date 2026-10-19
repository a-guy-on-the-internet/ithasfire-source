import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingHoldRecord } from "@th/ports/repos/booking-holds";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  addSetLength,
  anchorPreferredDate,
  parsePreferredDateEntry,
  resolveCalendarDefaultStartTime,
} from "../booking-agreements/_shared/pitch-seed";
import {
  createEventFromAgreementForHold,
  type CreateEventFromAgreementDeps,
} from "../booking-agreements/create-event-from-agreement";
// ── P3b (asks) ──
import { effectiveSetLengthMinutes } from "../booking-requests/asks/map-ask-answers";
import { HOLD_MINT_AGREEMENT_STATUSES } from "../booking-agreements/_shared/agreement-mint-plan";
import { assertBookingPreflight } from "../booking-agreements/_shared/booking-preflight";
import {
  acceptBookingRequestInTx,
  deriveCounterparty,
} from "../booking-requests/_shared/accept-in-tx";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  withCommittedHoldIntents,
  type BookingHoldNotificationIntent,
} from "./_shared/booking-hold-intents";
import {
  bookingHoldOutputSchema,
  loadStaffRequestHoldContext,
  toBookingHoldOutput,
} from "./_shared/hold-context";
import {
  assertLineSetCovered,
  isHoldStatusConflict,
  lineKeysOf,
  lockLines,
} from "./_shared/hold-line";
import {
  assertBookingEventOnNight,
  assessNight,
  bookingNightOf,
  failBookingAlreadyHasNight,
  failBookingCancelled,
  failDateNotAskedFor,
  failNightTaken,
  isAskedForNight,
  isBookingCancelled,
  otherBookedNight,
  resolveBookingEvent,
} from "./_shared/booking-night";
import { reportPostCommitRefusal } from "./_shared/post-commit-report";
import { settleLine } from "./_shared/settle-lapsed-holds";
import { takeLine } from "./_shared/take-line";

// ─────────────────────────────────────────────────────────────────────────────
// bookNightWithoutTerms (booking-the-night FR-004, N3; N6, N17) — the venue
// books a night the pitch asked for, with no agreed terms. Formerly the hold
// confirm (booking-holds FR-008), whose body this is: the confirm left the
// request flow (FR-005, `confirm-booking-hold.ts` now refuses), and this is
// the one venue action that may book a request's night without the sender's
// "Agree & book" (N4).
//
//   gates (no writes):      the actor is the place's STAFF (owner /
//                           edit-role member; a booking grantee is refused,
//                           holds-without-a-request FR-002); the hold
//                           belongs to THIS request; its night is one the
//                           pitch asked for (a preferred date; RENT / USE,
//                           inside the requested window) — else
//                           DATE_NOT_ASKED_FOR.
//   pre-flight (no writes): STANDING PRINCIPLE — every deterministic refusal
//                           the post-commit mint can raise is checked BEFORE
//                           tx1, because tx1 releases competitors with
//                           `lost_date`, which cannot be undone. Here: the
//                           hold is live, the request is open or ACCEPTED,
//                           its sender is a CLAIMED (owned) act, terms out or
//                           agreed for another night refuse; then the booking
//                           pre-flight every line-taking path calls
//                           (`assertBookingPreflight`): the place takes
//                           bookings, and the hold mint's OWN plan
//                           (`planAgreementMint`, agreement-mint-plan.ts —
//                           every refusal that mint can raise: the request's
//                           event live and on the night (N11), the terms not
//                           terminal, the actor's authority, the save's
//                           owner / counterparty gates and
//                           the owning org's quota). The plan's outcome is
//                           then EXECUTED post-commit: an event it hands back
//                           needs no mint. An event that already exists is
//                           the harder fact: tx1 aligns the header to ITS
//                           instants, not the hold's.
//   tx1 (one transaction):  lock the line + every sibling line → settle the
//                           line → N6: refuse NIGHT_TAKEN (venue side: its
//                           meta points at the hold to challenge) when
//                           another party's hold is ahead of this one or has
//                           booked the night (an open challenge on another
//                           hold is always ahead — only position 1 can be
//                           challenged; the challenged hold ITSELF may be
//                           booked, the venue saying yes early) → take the
//                           line (`takeLine`: CAS → CONFIRMED, siblings
//                           SIBLING_CONFIRMED, everyone behind
//                           CONFIRMED_OTHER, renumber) → ACCEPT the request if
//                           it is still open (the existing accept body,
//                           `acceptBookingRequestInTx` — it drafts the
//                           agreement, which STAYS DRAFT: it is what "Add
//                           terms" opens later, never a second agreement) →
//                           ALIGN the agreement header's proposedDate to the
//                           booked night (`alignAgreementDateToHold`). The
//                           instant, in precedence order: an existing event's
//                           own startsAt → the act's NAMED time on the hold's
//                           date (a `YYYY-MM-DDTHH:MM` preferred entry) → the
//                           hold's calendar defaultStartTime → 19:00, place
//                           zone. The same instant is what the mint anchors
//                           the event on → ledger `booking_hold.confirmed
//                           {eventId: null, withoutTerms: true}` + `.released`
//                           per loser → audit.
//   post-commit:            mint the draft Event through the existing
//                           create-event-from-agreement path, hold variant
//                           (`createEventFromAgreementForHold`): placed on the
//                           hold's calendar/space at the night's instant, NO
//                           finalize — there are no agreed terms, so the
//                           event's money goes 100% to its organiser (the
//                           venue for PERFORM, the requester for RENT / USE)
//                           until terms are added. That path appends its own
//                           `booking_event.created`. The sender hears through
//                           the existing `booking.hold-confirmed` notice (the
//                           `hold.confirmed` intent; its copy already says the
//                           date is booked and a draft event exists).
//
// Why two steps and not one: the event mint runs the standard save internals
// (quota, seat materialization, tax stamping) inside THEIR idempotency
// envelope/tx, which cannot be nested in ours. The split is safe because
// every step is idempotent on the hold id:
//   - hold already CONFIRMED             → tx1 is skipped;
//   - agreement already has an event     → returned, no mint;
//   - mint throws                        → tx1 stays committed (the night IS
//                                          booked, the request IS accepted);
//                                          re-running heals by minting only.
//                                          The error propagates, and a domain
//                                          refusal is reported first
//                                          (`reportPostCommitRefusal`): after
//                                          the pre-flight it can only be a
//                                          race with that read.
//
// OPERATOR RECOVERY — a CONFIRMED hold with no event (the mint failed after
// tx1: a quota used up or a place suspended between the pre-flight and the
// mint, a transient DB error):
//   1. `booking_hold.confirmed {eventId: null}` is on the thread and no
//      `booking_event.created` follows it — that is the signature.
//   2. Any ELIGIBLE actor re-runs this on the same hold id: tx1 is skipped
//      (hold already CONFIRMED) and only the mint runs. "Eligible" is the
//      gates + pre-flight above — the agreement's venue counterparty
//      themselves (human-owned venue), or an edit-role member of the
//      counterparty org. A different human owner of the same place cannot
//      mint on the counterparty's behalf (NOT_RESOURCE_OWNER); route the
//      re-run to the right person rather than working around it.
//   3. A re-run against an agreement whose event was since RESCHEDULED to
//      another night throws HOLD_DATE_MISMATCHES_EVENT — by design.
//
// NFR-001: two venue staff booking different holds in one line serialise on
// the line lock; the second reads the first's CONFIRMED row and is refused
// NIGHT_TAKEN. The DB's one-CONFIRMED-per-line partial unique is the
// backstop (HOLD_LINE_ALREADY_CONFIRMED). Never retried.
// ─────────────────────────────────────────────────────────────────────────────

export const bookNightWithoutTermsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
    holdId: z.uuid(),
  })
  .strict();

export const bookNightWithoutTermsOutputSchema = z
  .object({
    hold: bookingHoldOutputSchema,
    eventId: z.uuid(),
    agreementId: z.uuid(),
    /** Every hold tx1 released (siblings + competitors), for the caller's UI. */
    releasedHoldIds: z.array(z.uuid()),
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema,
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const bookNightWithoutTermsWireOutputSchema = z.object(
  bookNightWithoutTermsOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type BookNightWithoutTermsInput = z.infer<
  typeof bookNightWithoutTermsInputSchema
>;
export type BookNightWithoutTermsOutput = z.infer<
  typeof bookNightWithoutTermsOutputSchema
>;
export type BookNightWithoutTermsWireOutput = z.infer<
  typeof bookNightWithoutTermsWireOutputSchema
>;

export type BookNightWithoutTermsDeps = {
  /** Full bag — the post-commit mint runs the standard save internals. */
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  taxRateLookup?: TaxRateLookupPort | null;
  /** Threaded into the mint's orphan-draft branch; also the pitch-seed lookup. */
  reportError?: ReporterPort;
  /**
   * Pass-through to the shared mint: an org sender's SELF row on the bill
   * links the org's public page (lineup-booking-requests v2, FR-006).
   */
  publicAppUrl?: string | null;
  /**
   * `canManagePlace`, passed through to the shared mint's save internals
   * (REQUIRED there — place-address-withholding W1). Wire from `ctx.authz`.
   */
  authz: Pick<AuthZPort, "canManagePlace">;
  // ── P3b (asks) ── pass-through to the mint's ask-image copy (V10).
  storage?: CreateEventFromAgreementDeps["storage"];
};

const OPEN_STATUSES = ["PENDING", "VIEWED"] as const;

function isLineConfirmedConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_line_confirmed"
  );
}

function isAgreementStatusConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "agreement_status_changed"
  );
}

/**
 * The confirmed hold's night IS the agreed date. The accept seeds the
 * agreement header from the pitch's FIRST preferred date
 * (`computeAgreementPitchSeed`), while the post-commit mint puts the event on
 * the HOLD's date — so confirming a hold on any other preferred date left
 * `proposedDate` on one night and the hold + event on another (the event
 * editor's Booking panel and the agreement header showed the wrong date).
 * This rewrites the header to the SAME instant the event sits on, inside
 * tx1: an EXISTING event's own `startsAt` (pre-flight verified it is on the
 * hold's night; the venue placed it, so it is the harder fact) or, when the
 * mint is still to come, `holdStartsAt` — computed once by the caller and
 * handed to the mint unchanged, so header and event cannot drift.
 *
 * Skipped — returns null — when:
 *   - the agreement is finalized (`eventId` set) or in a status a hold may
 *     not mint on (the same `HOLD_MINT_AGREEMENT_STATUSES` gate, which is
 *     also the CAS `expectedFrom`);
 *   - nothing would change: for a HOLD anchor, the stored `proposedDate` is
 *     already the hold's instant (start-only — with the same start the
 *     stored span IS the target span); for an EVENT anchor, BOTH the start
 *     and the computed end already match the event's. This is what makes
 *     the write idempotent (a replay skips tx1 entirely; the race branch
 *     never reaches here) and keeps pitch provenance intact when the hold
 *     IS the first preferred date.
 *
 * `proposedEndDate` — the span rule: an existing event's own `endsAt −
 * startsAt` when anchoring on the event; otherwise the stored NEGOTIATED
 * `proposedEndDate − proposedDate` (a venue-edited "two hours" is a deal
 * term, not a night). A positive span is shifted onto the new start as-is;
 * with none, the pitch seed's own rule applies (`addSetLength`): the new
 * start + the request's set length when it named one, else null. Either way
 * an end pinned to the OLD night never outlives the start it belonged to.
 *
 * No ledger entry: there is no `booking_agreement.*` kind for a header edit
 * (`BOOKING_SYSTEM_ENTRY_KINDS`), and `booking_hold.confirmed` already
 * records the date. The change is captured in the confirm's audit row.
 * Provenance needs no flag: `deriveAgreementPitchProvenance` compares the
 * stored instant against the pitch's, and this write moves it off the pitch.
 */
type AgreementDateAnchor =
  | { source: "event"; startsAt: Date; endsAt: Date | null }
  | { source: "hold"; startsAt: Date };

async function alignAgreementDateToHold(
  tx: Pick<TxRepos, "agreements">,
  args: {
    agreementId: string;
    anchor: AgreementDateAnchor;
    setLengthMinutes: number | null;
    /** The night being booked, to compare PROPOSED terms against. */
    night: { date: string; placeTz: string };
  },
): Promise<{ from: Date | null; to: Date } | null> {
  const { anchor } = args;
  const agreement = await tx.agreements.getById(args.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  // Terms out with the sender are never rewritten under them (review W3):
  // for another night the booking is refused (re-checked here, in tx1, in
  // case they were sent after pre-flight); for this night they stand as sent.
  if (isTermsOutOrAgreed(agreement)) {
    if (
      agreement.proposedDate &&
      bookingNightOf(agreement.proposedDate, args.night.placeTz) !==
        args.night.date
    ) {
      failTermsSentForAnotherNight(agreement, args.night);
    }
    return null;
  }
  if (
    agreement.eventId !== null ||
    !(HOLD_MINT_AGREEMENT_STATUSES as readonly string[]).includes(
      agreement.status,
    )
  ) {
    return null;
  }
  const spanMs =
    anchor.source === "event"
      ? anchor.endsAt
        ? anchor.endsAt.getTime() - anchor.startsAt.getTime()
        : 0
      : agreement.proposedDate && agreement.proposedEndDate
        ? agreement.proposedEndDate.getTime() -
          agreement.proposedDate.getTime()
        : 0;
  const proposedEndDate =
    spanMs > 0
      ? new Date(anchor.startsAt.getTime() + spanMs)
      : addSetLength(anchor.startsAt, args.setLengthMinutes);
  const sameStart =
    agreement.proposedDate?.getTime() === anchor.startsAt.getTime();
  const sameEnd =
    (agreement.proposedEndDate?.getTime() ?? null) ===
    (proposedEndDate?.getTime() ?? null);
  if (sameStart && (anchor.source === "hold" || sameEnd)) {
    return null;
  }
  try {
    await tx.agreements.updateHeader({
      id: agreement.id,
      // Never PROPOSED: terms out with the sender are not rewritten under
      // them (review W3). A send that lands between the read above and this
      // write makes the CAS miss — handled below.
      expectedFrom: HEADER_REWRITABLE_STATUSES,
      proposedDate: anchor.startsAt,
      proposedEndDate,
    });
  } catch (error) {
    if (!isAgreementStatusConflict(error)) throw error;
    const now = await tx.agreements.getById(agreement.id);
    if (now && isTermsOutOrAgreed(now)) {
      // Just sent (or sent and agreed): for another night the booking is
      // refused; for this night the terms stand and nothing is rewritten.
      if (
        now.proposedDate &&
        bookingNightOf(now.proposedDate, args.night.placeTz) !== args.night.date
      ) {
        failTermsSentForAnotherNight(now, args.night);
      }
      return null;
    }
    throw error;
  }
  return { from: agreement.proposedDate, to: anchor.startsAt };
}

/**
 * TERMS_SENT_FOR_ANOTHER_NIGHT (venue side): terms for another night are with
 * the sender; booking this night without terms would contradict them. The
 * venue pulls them back or sends new ones first.
 */
function failTermsSentForAnotherNight(
  agreement: Pick<AgreementRecord, "id" | "proposedDate" | "status">,
  night: { date: string; placeTz: string },
): never {
  // Sent and waiting → pull back or wait; already AGREED → reopen first
  // (review W4: agreed terms are never rewritten either).
  throw fail(
    agreement.status === "ACCEPTED"
      ? "TERMS_AGREED_FOR_ANOTHER_NIGHT"
      : "TERMS_SENT_FOR_ANOTHER_NIGHT",
    {
      meta: {
        agreementId: agreement.id,
        holdDate: night.date,
        termsDate: agreement.proposedDate
          ? bookingNightOf(agreement.proposedDate, night.placeTz)
          : null,
      },
    },
  );
}

/**
 * Terms the sender has seen (PROPOSED) or agreed (ACCEPTED, not yet
 * finalized): a booking never rewrites them (review W3 / W4).
 */
function isTermsOutOrAgreed(
  agreement: Pick<AgreementRecord, "status" | "eventId">,
): boolean {
  return (
    agreement.status === "PROPOSED" ||
    (agreement.status === "ACCEPTED" && agreement.eventId === null)
  );
}

/**
 * Statuses whose header a booking may move onto the booked night:
 * `HOLD_MINT_AGREEMENT_STATUSES` minus PROPOSED and ACCEPTED — terms the
 * sender has seen or agreed are never rewritten (review W3 / W4).
 */
const HEADER_REWRITABLE_STATUSES = HOLD_MINT_AGREEMENT_STATUSES.filter(
  (status) => status !== "PROPOSED" && status !== "ACCEPTED",
);

/**
 * What pre-flight learned about the request's event, for tx1's header
 * alignment and the post-commit step:
 *   - `live` — an event that exists and sits on the hold's night (finalized,
 *     a live draft, or the live event-first origin): it anchors the header
 *     and is handed back (or linked);
 *   - `dead` — a CANCELLED/ARCHIVED draft anchor (not event-first): the hold
 *     anchors the header and the mint replaces it with a fresh draft;
 *   - `none` — no event yet: the mint creates it.
 */
type ExistingHoldEvent = { id: string; startsAt: Date; endsAt: Date | null };

type PreflightEvent =
  | { kind: "live"; event: ExistingHoldEvent }
  | { kind: "dead"; eventId: string }
  | { kind: "none" };

export async function bookNightWithoutTerms(
  deps: BookNightWithoutTermsDeps,
  rawInput: unknown,
): Promise<BookNightWithoutTermsOutput> {
  const input = parseInput(bookNightWithoutTermsInputSchema, rawInput);
  const now = deps.clock.now();
  // Staff only (FR-002: confirming an act's request hold is not a booker
  // action). Request holds only: a request-less hold is booked by making its event
  // (holds-without-a-request FR-008, plan step 7), never by this path.
  const ctx = await loadStaffRequestHoldContext(
    deps.repos,
    input.holdId,
    input.actorHumanId,
  );
  const { request, place, ownership, placeTz } = ctx;

  // ── Gates (read-only) ─────────────────────────────────────────────────────
  // The hold must hang off THIS request — the thread the venue is acting in.
  // A mismatch reads as not-found: the id pair names no hold.
  if (ctx.hold.bookingRequestId !== input.bookingRequestId) {
    throw fail("BOOKING_HOLD_NOT_FOUND");
  }
  // N3: only on a night the pitch asked for; any other night needs terms.
  if (!isAskedForNight(request, ctx.hold.date, placeTz)) {
    failDateNotAskedFor(ctx.hold.id, ctx.hold.date);
  }

  // ── Pre-flight (read-only) ────────────────────────────────────────────────
  if (ctx.hold.status === "RELEASED") {
    throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
  }

  const needsAccept = (OPEN_STATUSES as readonly string[]).includes(
    request.status,
  );
  if (!needsAccept && request.status !== "ACCEPTED") {
    throw fail("INVALID_STATUS", {
      message: "booking_request_closed",
      meta: { bookingRequestId: request.id, status: request.status },
    });
  }

  // A booking needs an OWNED sender to mint the Agreement/event for. An
  // anonymous embed inquiry has none: open, it would be accepted through
  // invite-to-claim (no agreement); ACCEPTED-but-unclaimed, it has no
  // agreement either. Both would pass tx1 (competitors released, lost_date
  // sent) and then fail the mint forever — refuse BEFORE any write.
  // `isUnclaimedBookingInquiry` is checked ALONGSIDE the sender narrowing, not
  // instead of it: since booking-inquirer-outreach an inquiry the venue has
  // replied to reads as OWNED (a shadow pair) while still having no real
  // counterparty, and confirming it would mint an Agreement naming a Human
  // nobody can sign in as. Both conditions must hold for a booking.
  const sender = getBookingRequestSender(request);
  if (
    sender.kind !== "owned" ||
    isUnclaimedBookingInquiry(request) ||
    (!needsAccept && request.agreementId == null)
  ) {
    throw fail("HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST", {
      meta: {
        bookingRequestId: request.id,
        status: request.status,
        holdId: ctx.hold.id,
      },
    });
  }

  // Terms already out with the sender (or agreed) are never rewritten: for
  // another night the booking is refused; for THIS night the event starts
  // at their instant (review W3 / W4).
  let proposedTermsStart: Date | null = null;
  let existingAgreement: AgreementRecord | null = null;
  if (!needsAccept && request.agreementId) {
    const agreement = await deps.repos.agreements.getById(request.agreementId);
    if (!agreement) {
      throw fail("AGREEMENT_NOT_FOUND");
    }
    if (isTermsOutOrAgreed(agreement) && agreement.proposedDate) {
      if (bookingNightOf(agreement.proposedDate, placeTz) !== ctx.hold.date) {
        failTermsSentForAnotherNight(agreement, {
          date: ctx.hold.date,
          placeTz,
        });
      }
      proposedTermsStart = agreement.proposedDate;
    }
    existingAgreement = agreement;
  }

  // The venue party an open request's terms will name (the accept in tx1
  // drafts them) — whose event quota a fresh save charges.
  const counterparty = deriveCounterparty(ownership, place, input.actorHumanId);

  // The booking pre-flight (booking-preflight.ts): the place takes
  // bookings, then the hold mint's OWN plan (`planAgreementMint`) — every
  // refusal the post-commit mint could raise, read-only, before tx1. No
  // override: booked without terms, the event is its organiser's by intent.
  const preflight = await assertBookingPreflight(deps.repos, {
    mode: "hold",
    agreement: existingAgreement,
    pendingVenueCounterparty: existingAgreement ? null : counterparty,
    request,
    place,
    calendarId: ctx.hold.calendarId,
    nightDate: ctx.hold.date,
    placeTz,
    side: "venue",
    ownerOverride: null,
    startNamed: true, // the hold names the start
    actor: { humanId: input.actorHumanId, now },
  });
  const preflightEvent: PreflightEvent = preflight.event
    ? {
        kind: "live",
        event: {
          id: preflight.event.id,
          startsAt: preflight.event.startsAt,
          endsAt: preflight.event.endsAt ?? null,
        },
      }
    : preflight.deadDraftEventId
      ? { kind: "dead", eventId: preflight.deadDraftEventId }
      : { kind: "none" };

  // Pitch-seed context for the accept, resolved OUTSIDE the tx exactly as
  // respondInternal does (degradable calendars read must not widen the lock).
  // NOTE: this is the REQUEST's routed calendar (the pitch the act sent —
  // it seeds the Agreement header), which may differ from the HOLD's
  // calendar; the event mint below anchors on the hold's calendar/space,
  // never the request's.
  const pitchContext = {
    timezone: placeTz,
    calendarDefaultStartTime: await resolveCalendarDefaultStartTime(
      { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
      { placeId: place.id, calendarId: request.calendarId },
    ),
  };

  // The hold's night as an instant, in the place zone, via the same
  // `anchorPreferredDate` the pitch seed uses. TIME precedence: the act's
  // NAMED time on the hold's date — a `YYYY-MM-DDTHH:MM` entry in the
  // request's preferredDates whose day IS the hold's (the act picked that
  // slot out of the venue's availability; a date-only entry names nothing)
  // → the HOLD's calendar defaultStartTime → 19:00. Computed ONCE, before
  // tx1, and used for BOTH the agreement header alignment (inside tx1) and
  // the event mint's `startsAt` (post-commit), so the agreement and the
  // event can never disagree — and the event lands on the act's named slot,
  // not the calendar default. An unanchorable date (impossible day) is
  // refused before any write.
  // First timed entry on that day wins — picker order is the act's preference.
  const namedSlotOnHoldDate = (request.preferredDates ?? []).find((entry) => {
    const parts = parsePreferredDateEntry(entry);
    return parts?.date === ctx.hold.date && parts.time !== null;
  });
  const holdStartsAt =
    proposedTermsStart ??
    anchorPreferredDate(
    namedSlotOnHoldDate ?? ctx.hold.date,
    placeTz,
    ctx.hold.calendarId === request.calendarId
      ? pitchContext.calendarDefaultStartTime
      : await resolveCalendarDefaultStartTime(
          {
            repos: deps.repos,
            logger: deps.logger,
            reportError: deps.reportError,
          },
          { placeId: place.id, calendarId: ctx.hold.calendarId },
        ),
  );
  if (!holdStartsAt) {
    throw fail("INVALID_STATUS", {
      message: "hold_date_unanchorable",
      meta: { holdId: ctx.hold.id, date: ctx.hold.date },
    });
  }

  // ── tx1 ───────────────────────────────────────────────────────────────────
  let tx1: {
    hold: BookingHoldRecord;
    agreementId: string | null;
    releasedHoldIds: string[];
    intents: BookingHoldNotificationIntent[];
  };
  if (ctx.hold.status === "CONFIRMED") {
    // Idempotent replay: tx1 already happened (possibly with a failed mint).
    tx1 = {
      hold: ctx.hold,
      agreementId: request.agreementId,
      releasedHoldIds: [],
      intents: [],
    };
  } else {
    try {
      tx1 = await deps.repos.tx(async (tx) => {
        const key = { calendarId: ctx.hold.calendarId, date: ctx.hold.date };
        // LOCK ORDER: every line this tx will touch — the hold's own line and
        // every line a SIBLING hold sits in — locked up front in the global
        // sorted order (hold-line.ts), before any read a write depends on.
        // A concurrent closure/confirm touching an overlapping set locks the
        // same keys in the same order and waits, never deadlocks. The locks
        // are re-entrant, so settleLine/renumberLine below cost nothing.
        // The lock SET comes from a pre-lock read; a hold placed on a NEW
        // line between that read and the locks would sit outside the set,
        // so re-read under the locks and give up (HOLD_LINE_CHANGED, the
        // client retries) if the set grew. Everything below works from the
        // post-lock rows.
        // The request's booking lock first (P2c): Cancel booking, Withdraw,
        // Close request and the other takes serialize on it.
        await tx.bookingHolds.lockRequestBooking(request.id);
        const lockedKeys = lineKeysOf([
          ctx.hold,
          ...(await tx.bookingHolds.listForRequest(request.id)),
        ]);
        await lockLines(tx, lockedKeys);
        const requestHolds = await tx.bookingHolds.listForRequest(request.id);
        assertLineSetCovered(lockedKeys, requestHolds);
        // A cancelled booking is never booked again (FR-009, N13).
        if (isBookingCancelled(requestHolds)) {
          failBookingCancelled();
        }
        // One booked night per request (review B1): takeLine releases only
        // LIVE siblings, so a night booked earlier would survive beside this.
        if (otherBookedNight(requestHolds, key)) {
          failBookingAlreadyHasNight();
        }
        // The booking's event, under the lock: a live draft / finalized link
        // / event-first origin must be on this night, and a gone origin
        // refuses (spec N11) — the same rule as pre-flight and the link.
        const freshRequest =
          (await tx.bookingRequests.getById(request.id)) ?? request;
        const freshAgreement = freshRequest.agreementId
          ? await tx.agreements.getById(freshRequest.agreementId)
          : null;
        assertBookingEventOnNight(
          await resolveBookingEvent(tx, {
            agreement: freshAgreement,
            request: freshRequest,
          }),
          {
            night: key.date,
            placeTz,
            side: "venue",
            agreementId: freshRequest.agreementId,
            calendarId: key.calendarId,
          },
        );
        // N3: "without terms" = no AGREED terms for this night. Terms the
        // sender already agreed for this night (review W4) make this a
        // booking WITH terms; sent-but-unanswered terms do not.
        const withoutTerms = !(
          freshAgreement?.status === "ACCEPTED" &&
          freshAgreement.proposedDate !== null &&
          bookingNightOf(freshAgreement.proposedDate, placeTz) === key.date
        );

        const { line, intents } = await settleLine(tx, {
          ...key,
          now,
          placeTz,
        });

        const fresh = line.find((h) => h.id === ctx.hold.id);
        if (!fresh) {
          const row = await tx.bookingHolds.getById(ctx.hold.id);
          if (row?.status === "CONFIRMED") {
            // Raced with our own replay — nothing more to do in tx1.
            return {
              hold: row,
              agreementId: null,
              releasedHoldIds: [],
              intents,
            };
          }
          throw fail("BOOKING_HOLD_NOT_LIVE", {
            meta: { holdId: ctx.hold.id },
          });
        }

        // N6, under the line lock: nobody else ahead of this hold, nobody
        // else booked on the night. Venue side, so the refusal names the
        // hold in the way (the one to challenge).
        const night = assessNight({
          line,
          confirmed: await tx.bookingHolds.listLine({
            ...key,
            statuses: ["CONFIRMED"],
          }),
          bookingRequestId: request.id,
        });
        if (night.kind === "taken") {
          failNightTaken(night, key.date);
        }

        // Take the line (take-line.ts): open-challenge guard → CAS the hold
        // → CONFIRMED → release SIBLINGS (SIBLING_CONFIRMED) and every
        // COMPETITOR (CONFIRMED_OTHER) → renumber the sibling lines. Shared
        // with FR-018 (a published event taking the date), so the two never
        // drift.
        const taken = await takeLine(tx, {
          key,
          line,
          winner: { hold: fresh, requestHolds },
          now,
          actorHumanId: input.actorHumanId,
        });
        const { released } = taken;
        const confirmed = taken.confirmed;
        if (!confirmed) {
          // takeLine always confirms when handed a winner; a null here is a
          // programmer error, not a runtime branch.
          throw new Error("take_line_without_confirmed_winner");
        }

        // Accept if still open — the SAME body respond uses, inside this tx.
        let agreementId = request.agreementId;
        if (needsAccept) {
          const accepted = await acceptBookingRequestInTx(tx, {
            request,
            place,
            counterparty,
            pitchContext,
            actorHumanId: input.actorHumanId,
            now,
          });
          agreementId = accepted.agreementId;
        }

        // The confirmed night is the agreed date — see alignAgreementDateToHold.
        // `agreementId` is always set here: an open request was just accepted
        // (minting one) and an ACCEPTED request without one was refused in
        // pre-flight (HOLD_CONFIRM_REQUIRES_CLAIMED_REQUEST).
        const agreementDateAligned = agreementId
          ? await alignAgreementDateToHold(tx, {
              agreementId,
              anchor:
                preflightEvent.kind === "live"
                  ? {
                      source: "event",
                      startsAt: preflightEvent.event.startsAt,
                      endsAt: preflightEvent.event.endsAt,
                    }
                  : { source: "hold", startsAt: holdStartsAt },
              // ── P3b (asks) ── the pitch's set length, else the answered
              // SET_LENGTH ask (V10), so a night booked after the answer
              // still gets its end.
              setLengthMinutes: await effectiveSetLengthMinutes(tx, request),
              night: { date: ctx.hold.date, placeTz },
            })
          : null;

        await appendBookingSystemEntry(tx, {
          // `confirmed` is the request hold the context loaded.
          bookingRequestId: request.id,
          kind: "booking_hold.confirmed",
          // N3: written only when the night was booked with no agreed terms.
          data: {
            holdId: confirmed.id,
            eventId: null,
            ...(withoutTerms ? { withoutTerms: true } : {}),
          },
          actorHumanId: input.actorHumanId,
        });

        await tx.audit.log({
          entity: "booking_hold",
          entityId: confirmed.id,
          action: "booking_hold.confirmed",
          data: {
            actorHumanId: input.actorHumanId,
            bookingRequestId: request.id,
            placeId: place.id,
            calendarId: confirmed.calendarId,
            date: confirmed.date,
            position: confirmed.position,
            acceptedRequest: needsAccept,
            agreementId,
            agreementDateAligned,
            withoutTerms,
            releasedHoldIds: released.map((h) => h.id),
          },
          at: now,
        });

        return {
          hold: confirmed,
          agreementId,
          releasedHoldIds: released.map((h) => h.id),
          intents: [...intents, ...taken.intents],
        };
      });
    } catch (error) {
      if (isLineConfirmedConflict(error)) {
        throw fail("HOLD_LINE_ALREADY_CONFIRMED", {
          meta: {
            holdId: ctx.hold.id,
            calendarId: ctx.hold.calendarId,
            date: ctx.hold.date,
          },
        });
      }
      if (isHoldStatusConflict(error)) {
        // Our CAS lost to a concurrent transition on THIS hold.
        throw fail("BOOKING_HOLD_NOT_LIVE", { meta: { holdId: ctx.hold.id } });
      }
      if (isAgreementStatusConflict(error)) {
        // The header align's CAS lost to a concurrent agreement transition
        // (declined/cancelled mid-confirm). tx1 rolled back — nothing was
        // released; a retry re-reads the agreement and pre-flight rules.
        throw fail("INVALID_STATUS", {
          message: "agreement_status_changed",
          meta: { holdId: ctx.hold.id },
        });
      }
      throw error;
    }
  }

  // ── Post-commit: the event ────────────────────────────────────────────────
  // tx1 is committed: the night is booked and the losers are released. If
  // anything below throws, the notices tx1 owes (lost_date to the acts
  // behind, the sender's hold-confirmed) ride OUT ON THE ERROR so the
  // transport still sends them (review W6) — a replay skips tx1 and owes
  // nothing, so nobody is told twice.
  let agreementId: string;
  let eventId: string;
  try {
    // Re-read the agreement id on replay paths (tx1 skipped or raced) — the
    // request row we loaded may predate the accept.
    const linkedAgreementId =
      tx1.agreementId ??
      (await deps.repos.bookingRequests.getById(request.id))?.agreementId ??
      null;
    if (!linkedAgreementId) {
      throw fail("INVALID_STATUS", {
        message: "confirmed_hold_without_agreement",
        meta: { holdId: tx1.hold.id, bookingRequestId: request.id },
      });
    }

    agreementId = linkedAgreementId;
    const agreement = await deps.repos.agreements.getById(agreementId);
    if (!agreement) {
      throw fail("AGREEMENT_NOT_FOUND");
    }
    // Execute the plan: an event it hands back (finalized link, live draft)
    // needs no mint; a link or a fresh save goes through the hold mint, which
    // runs the same plan again (any refusal now is a race — reported below).
    const handedBack =
      preflight.outcome === "finalized" || preflight.outcome === "draft"
        ? preflight.event!.id
        : null;
    if (handedBack) {
      eventId = handedBack;
    } else {
      // The HOLD's calendar (not the request's) anchors the event — see the
      // pitch-context note above; `holdStartsAt` is the instant tx1 wrote to
      // the agreement header, and the header's end (re-read after tx1) is the
      // event's end, so the two durations cannot disagree.
      const headerEnd = agreement.proposedEndDate;
      // Terms that went out for THIS night while the night was being booked
      // (tx1 left them untouched): the event starts at their instant.
      const startsAt =
        isTermsOutOrAgreed(agreement) &&
        agreement.proposedDate &&
        bookingNightOf(agreement.proposedDate, placeTz) === tx1.hold.date
          ? agreement.proposedDate
          : holdStartsAt;
      const minted = await createEventFromAgreementForHold(deps, {
        actorHumanId: input.actorHumanId,
        agreementId,
        hold: {
          id: tx1.hold.id,
          calendarId: tx1.hold.calendarId,
          spaceId: tx1.hold.spaceId,
          date: tx1.hold.date,
          startsAt,
          endsAt:
            headerEnd && headerEnd.getTime() > startsAt.getTime()
              ? headerEnd
              : null,
        },
      });
      eventId = minted.eventId;
    }
  } catch (error) {
    // The night is booked but its event did not land: after the pre-flight a
    // domain refusal here is a race with that read (e.g. the origin event
    // moved off the night, review W5). It is user-facing, so the Sentry
    // backstop drops it — report it.
    reportPostCommitRefusal(deps, error, {
      event: "booking_holds.book_night.post_commit_refused",
      useCase: "bookNightWithoutTerms",
      step: "post_commit_mint",
      extra: { holdId: tx1.hold.id, bookingRequestId: request.id },
    });
    throw withCommittedHoldIntents(error, {
      notificationIntents: tx1.intents,
      staffRecipientHint: ctx.staffRecipientHint,
      bookingRequestId: request.id,
    });
  }

  deps.logger?.info("booking_holds.booked_without_terms", {
    holdId: tx1.hold.id,
    bookingRequestId: request.id,
    agreementId,
    eventId,
    releasedHoldCount: tx1.releasedHoldIds.length,
    actorHumanId: input.actorHumanId,
  });

  return bookNightWithoutTermsOutputSchema.parse({
    hold: toBookingHoldOutput(tx1.hold, now, placeTz),
    eventId,
    agreementId,
    releasedHoldIds: tx1.releasedHoldIds,
    notificationIntents: tx1.intents,
    staffRecipientHint: ctx.staffRecipientHint,
  });
}
