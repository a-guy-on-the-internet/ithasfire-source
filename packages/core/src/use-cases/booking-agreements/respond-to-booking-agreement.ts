import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { ToVenueBookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { fail, isAppError } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import {
  otherSide,
  partyOnSide,
  requireAgreementParty,
  type AgreementSide,
} from "./_shared/agreement-access";
import { requireAgreementActSide } from "./_shared/agreement-editor-side";
import {
  bookingThreadSideForAgreementSide,
  findLedgerRequestForAgreement,
} from "./_shared/booking-ledger";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
  type BookingHoldNotificationIntent,
  type BookingHoldStaffRecipientHint,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  bookingNightOf,
  resolveNightCalendarId,
} from "../booking-holds/_shared/booking-night";
import { staffRecipientHintFor } from "../booking-holds/_shared/hold-context";
import { isHoldStatusConflict } from "../booking-holds/_shared/hold-line";
import { takeNightForTermsInTx } from "../booking-holds/_shared/take-night-for-terms";
import { assertBookingPreflight } from "./_shared/booking-preflight";
import { notifyAgreementParty } from "./_shared/notify-party";
import { resolveBookingTimezone } from "./_shared/pitch-seed";
import {
  createEventFromAgreementOnNight,
  type CreateEventFromAgreementDeps,
} from "./create-event-from-agreement";
import { agreementStatusSchema } from "./list-booking-agreements";
import type { BookingAgreementTransitionDeps } from "./send-booking-agreement-for-review";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-refine base object — the transport derives its input via
 * `.omit({ actorHumanId: true })`, which can't be applied after `.refine()`.
 *
 * `declineReason` is SANITIZED free text, matching
 * `respondToBookingRequestBaseSchema` exactly: `plainTextMultilineRequired`
 * strips tags/entities to a fixpoint and drops bidi/zero-width controls FIRST,
 * then `.pipe(min(3))` applies the floor to the CLEANED value — so a "reason"
 * made entirely of markup collapses to `""` and fails, instead of passing a
 * bare `.trim().min(3)` and being stored. This became load-bearing when the
 * string started being COPIED onto the booking ledger, where both parties read
 * it. (Not an XSS fix — React escapes, and the entry resolver passes it as an
 * ICU argument, never a pattern — it is the house sanitize-at-the-boundary
 * rule.)
 */
export const respondToBookingAgreementBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
    /**
     * Accept or decline ONLY. There is deliberately no "counter" action: the
     * act side never edits terms (owner decision 2026-08-25 — see
     * `_shared/agreement-editor-side.ts`), so a counter from the act would be
     * a terms edit by another name. The terms editor adjusts the draft
     * instead (pull back → edit → send again). A `counter` payload is
     * therefore an `invalid_input`, from either side.
     */
    action: z.enum(["accept", "decline"]),
    declineReason: plainTextMultilineRequired(1000)
      .pipe(z.string().min(3))
      .optional(),
    /**
     * The terms' date as the sender saw it on the card (booking-the-night,
     * "Agree & book"). When present and the terms now say something else,
     * the accept is refused TERMS_CHANGED_SINCE_VIEWED — the sender agrees
     * to the night they were shown, never one that moved under them. `null`
     * = they saw terms with no date. Optional until the card sends it (P5).
     */
    expectedProposedDate: z.coerce.date().nullable().optional(),
  })
  .strict();

export const respondToBookingAgreementInputSchema =
  respondToBookingAgreementBaseSchema.refine(
    (value) => value.action !== "decline" || value.declineReason !== undefined,
    { message: "decline_reason_required", path: ["declineReason"] },
  );

export const respondToBookingAgreementOutputSchema = z
  .object({
    agreementId: z.uuid(),
    status: agreementStatusSchema,
    acceptedAt: z.date().nullable(),
    declinedAt: z.date().nullable(),
    /**
     * The draft event an "Agree & book" created (or linked, event-first).
     * Null when nothing was booked (a decline, terms with no night, unlinked
     * or TO_PERFORMER terms) or when the post-commit mint did not land — the
     * night is booked either way and the venue's "Create event" retries.
     */
    eventId: z.uuid().nullable(),
    /** Hold notifications owed by an agree that booked the night. */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema),
    /** Their staff routing; null when nothing is owed. */
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable(),
  })
  .strict();

/** What transport puts on the wire: the intents + routing hint stay server-side. */
export const respondToBookingAgreementWireOutputSchema = z.object(
  respondToBookingAgreementOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type RespondToBookingAgreementInput = z.infer<
  typeof respondToBookingAgreementInputSchema
>;
export type RespondToBookingAgreementOutput = z.infer<
  typeof respondToBookingAgreementOutputSchema
>;
export type RespondToBookingAgreementWireOutput = z.infer<
  typeof respondToBookingAgreementWireOutputSchema
>;

/**
 * The transition bag plus what "Agree & book" needs: the full repo bag and
 * the mint's ports (the post-commit mint runs the standard save internals).
 */
export type RespondToBookingAgreementDeps = Omit<
  BookingAgreementTransitionDeps,
  "repos"
> & {
  repos: Repos;
  idempotency: IdempotencyPort;
  /** `canManagePlace` for the mint's save internals (W1). */
  authz: Pick<AuthZPort, "canManagePlace">;
  taxRateLookup?: TaxRateLookupPort | null;
  /** The lineup's org-page links (lineup-booking-requests v2, FR-006). */
  publicAppUrl?: string | null;
  // ── P3b (asks) ── pass-through to the agree-mint's ask-image copy (V10).
  storage?: CreateEventFromAgreementDeps["storage"];
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whole-agreement response on a PROPOSED agreement (spec FR-004):
 * `accept` → ACCEPTED (stamps acceptedAt); `decline` → DECLINED (stamps
 * declinedAt + required reason). CAS from PROPOSED only.
 *
 * DECLINED TERMS GO BACK TO DRAFT (booking-the-night N16, FR-012): when the
 * terms belong to a booking request that is still ACCEPTED, the decline is
 * PROPOSED → DRAFT (the pull-back CAS), not DECLINED: the ledger gets
 * `booking_agreement.declined` (with the reason) and
 * `booking_agreement.returned_to_draft`, and the venue is told the terms are
 * theirs to change and resend. The reason is required on every decline (the
 * input schema's refine; N18: required wherever something ends or is
 * refused). Unlinked terms, and terms on a closed request, keep DECLINED.
 *
 * RBAC: the responder must be a party with edit-level access, and on a
 * LINKED agreement must be the ACT (`requireAgreementActSide`) — this is the
 * one agreement action the act is allowed (accept / decline, never counter
 * or edit), and the editor cannot self-accept what it just sent. Unlinked
 * agreements have no act, so either party may still respond there.
 *
 * AGREE & BOOK (booking-the-night FR-001; N1, N5, N6, N10, N11, N17): an
 * accept of REQUEST-LINKED TO_VENUE terms that name a date books that night
 * in the same transaction (`takeNightForTermsInTx`: the line lock, the N6
 * re-check, the CAS, the line take, the ledger), then creates the draft event
 * AFTER COMMIT as the venue person who sent the terms
 * (`sentForReviewByHumanId`), their authority re-checked by the mint itself.
 * An event-first request links its origin event instead (the shared mint
 * does that). Every refusal is decided BEFORE the line moves — first by the
 * shared booking pre-flight (`assertBookingPreflight`, read-only, the same
 * one every line-taking path calls), then again under the line lock
 * (`takeRequestNightInTx`) — and none carries meta to the sender:
 *   - the place is suspended or retired → PLACE_NOT_TAKING_BOOKINGS;
 *   - the night went elsewhere since the send → NIGHT_NO_LONGER_AVAILABLE;
 *   - the request's event (finalized link, live draft, live event-first
 *     origin) sits on another day than the terms → EVENT_ON_ANOTHER_NIGHT;
 *   - event-first, and the origin event is cancelled / archived / gone →
 *     EVENT_FIRST_ORIGIN_GONE (spec N11: the night is not booked, whatever
 *     else anchors the request — owner ruling 2026-10-01);
 *   - the terms were finalized against an event that is now cancelled or
 *     archived → LINKED_EVENT_NOT_LIVE;
 *   - this request already booked another night → BOOKING_ALREADY_HAS_NIGHT;
 *   - the terms moved since the sender saw them → TERMS_CHANGED_SINCE_VIEWED.
 * For the first five the terms stay PROPOSED and the venue is told why (a
 * venue-only ledger entry + an in-app ping). The pre-flight runs WITHOUT the
 * venue actor's gates here (see booking-preflight.ts): the mint runs after
 * commit as a stand-in, the venue person who sent the terms. If it cannot
 * run (no recorded sender: terms sent before the column existed) or fails
 * (that person's authority, the venue org's event quota, a race), the night
 * stays booked and the terms ACCEPTED; the failure is logged + reported, and
 * the venue's "Create event" (idempotent on the draft anchor) is the retry.
 * Everything else — a decline, unlinked terms, TO_PERFORMER terms, terms
 * with no date — behaves exactly as before.
 */
export async function respondToBookingAgreement(
  deps: RespondToBookingAgreementDeps,
  rawInput: unknown,
): Promise<RespondToBookingAgreementOutput> {
  const input = parseInput(respondToBookingAgreementInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }
  if (agreement.status !== "PROPOSED") {
    throw fail("AGREEMENT_NOT_PROPOSED");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_EDIT_ROLES,
  });
  await requireAgreementActSide(deps.repos, agreement, party.side);

  const now = deps.clock.now();
  const accepted = input.action === "accept";

  if (
    accepted &&
    input.expectedProposedDate !== undefined &&
    (agreement.proposedDate?.getTime() ?? null) !==
      (input.expectedProposedDate?.getTime() ?? null)
  ) {
    // Sender side: no meta.
    throw fail("TERMS_CHANGED_SINCE_VIEWED");
  }

  if (accepted) {
    const booking = await resolveAgreeAndBook(deps, agreement);
    if (booking) {
      return agreeAndBook(deps, {
        agreement,
        booking,
        actorHumanId: input.actorHumanId,
        actorAgreementSide: party.side,
        now,
      });
    }
  }

  const { updated, returnedToDraft } = await deps.repos.tx(async (tx) => {
    // The request this agreement belongs to, read in the same tx as the CAS
    // (it decides the decline's target status, and is the ledger's home).
    const request = await findLedgerRequestForAgreement(tx, agreement.id);
    // N16 / FR-012: the sender declining REQUEST-LINKED terms sends them back
    // to the venue as a DRAFT to change and resend — the same PROPOSED →
    // DRAFT CAS pull-back uses — instead of ending the booking (lineup v3
    // punch list item 2). Only while the request is still ACCEPTED: on a
    // closed request there is no conversation to return to, and unlinked
    // terms have no request at all — both keep DECLINED (terminal).
    const backToDraft =
      !accepted && request !== null && request.status === "ACCEPTED";
    const next = await tx.agreements.updateStatus({
      id: agreement.id,
      status: accepted ? "ACCEPTED" : backToDraft ? "DRAFT" : "DECLINED",
      expectedFrom: ["PROPOSED"],
      ...(accepted
        ? { acceptedAt: now }
        : backToDraft
          ? // A DRAFT carries no decline stamp: `declinedAt` set means
            // DECLINED everywhere it is read. The reason lives on the ledger.
            {}
          : {
              declinedAt: now,
              declinedReason: input.declineReason ?? null,
            }),
    });

    // Ledger entry, same tx as the CAS. NOTE: this use case only ever writes
    // ACCEPTED, DECLINED or (a request-linked decline) DRAFT — nothing in the
    // codebase produces the `COUNTERED` AgreementStatus, so
    // `booking_agreement.countered` stays an unused kind rather than an
    // invented transition (see the module doc).
    if (request) {
      const actorSide = bookingThreadSideForAgreementSide(
        request,
        agreement,
        party.side,
      );
      if (accepted) {
        await appendBookingSystemEntry(tx, {
          bookingRequestId: request.id,
          kind: "booking_agreement.accepted",
          data: { agreementId: next.id, actorSide },
          actorHumanId: input.actorHumanId,
        });
      } else {
        await appendBookingSystemEntry(tx, {
          bookingRequestId: request.id,
          kind: "booking_agreement.declined",
          // Reason COPIED onto the entry, not read live off the mutable
          // `Agreement.declinedReason`.
          data: {
            agreementId: next.id,
            actorSide,
            reason: input.declineReason ?? null,
          },
          actorHumanId: input.actorHumanId,
        });
        if (backToDraft) {
          // The schema's emitter note: two entries in one tx share a
          // createdAt, so the thread may show these two in either order.
          await appendBookingSystemEntry(tx, {
            bookingRequestId: request.id,
            kind: "booking_agreement.returned_to_draft",
            data: {
              agreementId: next.id,
              ...(input.declineReason ? { reason: input.declineReason } : {}),
            },
            actorHumanId: input.actorHumanId,
          });
        }
      }
    }

    await tx.audit.log({
      entity: "booking_agreement",
      entityId: next.id,
      action: accepted
        ? "booking_agreement.accepted"
        : "booking_agreement.declined",
      data: {
        actorHumanId: input.actorHumanId,
        actorSide: party.side,
        ...(accepted
          ? {}
          : { declineReason: input.declineReason, returnedToDraft: backToDraft }),
      },
      at: now,
    });

    return { updated: next, returnedToDraft: backToDraft };
  });

  // Post-commit, best-effort (never fails the mutation). A decline that sent
  // the terms back tells the venue they are theirs to change and resend.
  await notifyAgreementParty(deps, {
    party: partyOnSide(updated, otherSide(party.side)),
    actorHumanId: input.actorHumanId,
    agreementId: updated.id,
    eventKey: accepted
      ? "accepted"
      : returnedToDraft
        ? // Terms can come back more than once: one ping per round sent,
          // keyed by that round's send (each send stamps proposedAt).
          `returned_to_draft:${agreement.proposedAt?.toISOString() ?? "unsent"}`
        : "declined",
    title: accepted
      ? "Agreement accepted"
      : returnedToDraft
        ? "Terms declined"
        : "Agreement declined",
    body: accepted
      ? `"${updated.title}" was accepted.`
      : returnedToDraft
        ? `"${updated.title}" was declined and is back in draft. Change the terms and send them again.`
        : `"${updated.title}" was declined.`,
  });

  deps.logger?.info("booking_agreements.responded", {
    agreementId: updated.id,
    action: input.action,
    returnedToDraft,
    actorHumanId: input.actorHumanId,
  });

  return respondToBookingAgreementOutputSchema.parse({
    agreementId: updated.id,
    status: updated.status,
    acceptedAt: updated.acceptedAt,
    declinedAt: updated.declinedAt,
    eventId: null,
    notificationIntents: [],
    staffRecipientHint: null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Agree & book (FR-001)
// ─────────────────────────────────────────────────────────────────────────────

type AgreeAndBookContext = {
  request: ToVenueBookingRequestRecord;
  place: NonNullable<Awaited<ReturnType<Repos["places"]["getById"]>>>;
  placeTz: string;
  proposedDate: Date;
  key: { calendarId: string; date: string };
  /** The venue human a hold written for the night is placed by. */
  placedByHumanId: string;
};

/**
 * Whether this accept books a night, and which one — or null for every
 * accept that keeps today's behaviour. Read-only, before any transaction.
 */
async function resolveAgreeAndBook(
  deps: RespondToBookingAgreementDeps,
  agreement: AgreementRecord,
): Promise<AgreeAndBookContext | null> {
  if (!agreement.proposedDate) return null;
  const request = await deps.repos.bookingRequests.findByAgreementId(
    agreement.id,
  );
  if (!request || request.direction !== "TO_VENUE") return null;
  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  const placeTz = resolveBookingTimezone(place.timezone);
  const date = bookingNightOf(agreement.proposedDate, placeTz);
  const calendarId = await resolveNightCalendarId(deps.repos, {
    request,
    placeId: place.id,
    night: date,
  });
  if (!calendarId) {
    throw fail("CALENDAR_NOT_FOUND", {
      meta: { reason: "place_has_no_calendar", placeId: place.id },
    });
  }
  return {
    request,
    place,
    placeTz,
    proposedDate: agreement.proposedDate,
    key: { calendarId, date },
    placedByHumanId: await resolveVenuePlacer(deps, agreement, request, place),
  };
}

/**
 * Who a hold written by the agree is placed by — always a VENUE human, never
 * the act: the terms' sender → the request's assignee → the venue party
 * itself (a human counterparty, or the counterparty org's first owner/admin)
 * → the place's first direct owner.
 */
async function resolveVenuePlacer(
  deps: RespondToBookingAgreementDeps,
  agreement: AgreementRecord,
  request: ToVenueBookingRequestRecord,
  place: AgreeAndBookContext["place"],
): Promise<string> {
  const direct =
    agreement.sentForReviewByHumanId ??
    request.assigneeHumanId ??
    (agreement.counterpartyType === "human" ? agreement.counterpartyId : null);
  if (direct) return direct;
  const members = await deps.repos.organizations.listMembers({
    orgId: agreement.counterpartyId,
    limit: 50,
    offset: 0,
  });
  const admin = members.items.find(
    (m) => m.role === "OWNER" || m.role === "ADMIN",
  );
  const placer = admin?.humanId ?? place.humanIdsWithAccess[0] ?? null;
  if (!placer) {
    throw fail("INVALID_STATUS", { message: "no_venue_human_to_place_hold" });
  }
  return placer;
}

function isAgreementStatusConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "agreement_status_changed"
  );
}

function isLineConfirmedConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_hold_line_confirmed"
  );
}

/** Why the venue is told an agree was refused, other than "night taken". */
type AgreeRefusedReason =
  | "event_on_another_night"
  | "event_origin_gone"
  | "linked_event_gone"
  | "place_not_taking_bookings";

/** The sender-side (meta-free) refusals the venue hears about, by code. */
const AGREE_REFUSED_REASON_BY_CODE: Partial<Record<string, AgreeRefusedReason>> = {
  EVENT_ON_ANOTHER_NIGHT: "event_on_another_night",
  EVENT_FIRST_ORIGIN_GONE: "event_origin_gone",
  LINKED_EVENT_NOT_LIVE: "linked_event_gone",
  PLACE_NOT_TAKING_BOOKINGS: "place_not_taking_bookings",
};

async function agreeAndBook(
  deps: RespondToBookingAgreementDeps,
  args: {
    agreement: AgreementRecord;
    booking: AgreeAndBookContext;
    actorHumanId: string;
    actorAgreementSide: AgreementSide;
    now: Date;
  },
): Promise<RespondToBookingAgreementOutput> {
  const { agreement, booking, actorHumanId, now } = args;
  const { request, key } = booking;
  const actorSide = bookingThreadSideForAgreementSide(
    request,
    agreement,
    args.actorAgreementSide,
  );
  const venueParty = partyOnSide(agreement, otherSide(args.actorAgreementSide));

  let taken;
  try {
    // The booking pre-flight (read-only): the place takes bookings, then the
    // mint's own plan for the terms as this take leaves them (ACCEPTED) —
    // the request's event live and on the night (N11), the terms' status.
    // Sender side: the event refusals are meta-free. No actor — see the
    // use-case doc.
    await assertBookingPreflight(deps.repos, {
      mode: "night",
      agreement: { ...agreement, status: "ACCEPTED" },
      request,
      place: booking.place,
      calendarId: key.calendarId,
      nightDate: key.date,
      placeTz: booking.placeTz,
      side: "sender",
      ownerOverride: null,
      startNamed: true, // the terms' date
      actor: null,
    });
    taken = await deps.repos.tx((tx) =>
      takeNightForTermsInTx(tx, {
        agreementId: agreement.id,
        bookingRequestId: request.id,
        expectedProposedDate: booking.proposedDate,
        key,
        placeTz: booking.placeTz,
        now,
        actorHumanId,
        actorSide,
        placedByHumanId: booking.placedByHumanId,
      }),
    );
  } catch (error) {
    // Every refusal below reaches the SENDER, so none carries meta: an act
    // learns its own outcome, never another party's hold, line or calendar
    // (booking-holds FR-013). The DB's one-CONFIRMED-per-line unique is the
    // backstop behind the line lock, and an open challenge on another hold
    // means that hold is ahead: all three are "the night went elsewhere".
    const nightGone =
      (isAppError(error) &&
        (error.code === "NIGHT_NO_LONGER_AVAILABLE" ||
          error.code === "HOLD_LINE_HAS_OPEN_CHALLENGE")) ||
      isLineConfirmedConflict(error);
    if (nightGone) {
      await tellVenueAgreeRefused(deps, {
        agreement,
        requestId: request.id,
        date: key.date,
        actorHumanId,
        venueParty,
        now,
        reason: "night_taken",
      });
      // Sender side: never any meta (booking-holds FR-013).
      throw fail("NIGHT_NO_LONGER_AVAILABLE");
    }
    const refusedReason = isAppError(error)
      ? AGREE_REFUSED_REASON_BY_CODE[error.code]
      : undefined;
    if (isAppError(error) && refusedReason) {
      // The place stopped taking bookings, or the request's event is gone or
      // on another day than these terms: refused BEFORE the line moved (by
      // the pre-flight, or under the lock). The venue is told; the sender's
      // refusal carries nothing.
      await tellVenueAgreeRefused(deps, {
        agreement,
        requestId: request.id,
        date: key.date,
        actorHumanId,
        venueParty,
        now,
        reason: refusedReason,
      });
      throw fail(error.code);
    }
    if (isAgreementStatusConflict(error)) {
      // A concurrent pull-back / cancel / second agree won the CAS; the whole
      // transaction rolled back, nothing was taken.
      throw fail("AGREEMENT_NOT_PROPOSED");
    }
    if (isHoldStatusConflict(error)) {
      // A hold moved under the take: retryable, and nothing to name.
      throw fail("HOLD_LINE_CHANGED");
    }
    if (isAppError(error)) {
      // Same code and message, never the thrower's meta (HOLD_LINE_CHANGED
      // from the lock helpers carries a calendarId, for one).
      throw fail(error.code, { message: error.message });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      !(error instanceof Error) &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      // A plain typed refusal (`{ code, message, meta }`, e.g. the save's
      // `forbidden: quota_exceeded`, whose meta names the venue org's
      // numbers): the sender gets its code and message, never its meta.
      const { code, message } = error as { code: string; message?: unknown };
      throw { code, message: typeof message === "string" ? message : code };
    }
    throw error;
  }

  // Post-commit, best-effort (never fails the mutation).
  await notifyAgreementParty(deps, {
    party: venueParty,
    actorHumanId,
    agreementId: taken.agreement.id,
    eventKey: "accepted",
    title: "Agreement accepted",
    body: `"${taken.agreement.title}" was accepted.`,
  });

  const eventId = await mintAgreedNight(deps, {
    agreement: taken.agreement,
    hold: taken.hold,
    night: key.date,
    bookingRequestId: request.id,
    actorHumanId,
    now,
  });

  deps.logger?.info("booking_agreements.agreed_and_booked", {
    agreementId: taken.agreement.id,
    bookingRequestId: request.id,
    holdId: taken.hold.id,
    holdCreated: taken.holdCreated,
    alreadyBooked: taken.alreadyBooked,
    releasedHoldCount: taken.released.length,
    eventId,
    actorHumanId,
  });

  // The sender just tapped "Agree & book": their own "your date is booked"
  // notice would only echo their tap. Everyone else's notices (lost_date to
  // the acts behind, the moves on the sibling lines) are owed as usual.
  const intents: BookingHoldNotificationIntent[] = taken.intents.filter(
    (intent) => !(intent.kind === "hold.confirmed" && intent.holdId === taken.hold.id),
  );
  const staffRecipientHint: BookingHoldStaffRecipientHint | null =
    intents.length > 0
      ? staffRecipientHintFor({
          hold: taken.hold,
          request,
          place: booking.place,
          ownership: null,
        })
      : null;

  return respondToBookingAgreementOutputSchema.parse({
    agreementId: taken.agreement.id,
    status: taken.agreement.status,
    acceptedAt: taken.agreement.acceptedAt,
    declinedAt: taken.agreement.declinedAt,
    eventId,
    notificationIntents: intents,
    staffRecipientHint,
  });
}

/**
 * N10: the mint runs as the venue person who sent the terms, after commit.
 * Its failure is a DELIBERATE DEGRADE, not a failed agree — the night is
 * booked and the terms are ACCEPTED, and "Create event" is the retry — so it
 * is logged at error AND reported (ReporterPort convention), guarded so a
 * throwing reporter never changes the outcome. The venue is told on its own
 * side of the thread (`booking_agreement.event_not_created`, VENUE-INTERNAL;
 * P2b review carry e): "the event wasn't created — use Create event".
 */
async function mintAgreedNight(
  deps: RespondToBookingAgreementDeps,
  args: {
    agreement: AgreementRecord;
    hold: { calendarId: string; spaceId: string | null };
    /** The booked night; an existing draft on another night is refused. */
    night: string;
    bookingRequestId: string;
    /** The sender who tapped "Agree & book" (the entry's author). */
    actorHumanId: string;
    now: Date;
  },
): Promise<string | null> {
  const { agreement } = args;
  const degrade = async (err: unknown, reason: string): Promise<null> => {
    report(err, reason);
    await tellVenueEventNotCreated(deps, {
      agreementId: agreement.id,
      bookingRequestId: args.bookingRequestId,
      date: args.night,
      actorHumanId: args.actorHumanId,
      now: args.now,
      reason,
    });
    return null;
  };
  const report = (err: unknown, reason: string) => {
    deps.logger?.error("booking_agreements.agree_mint_failed", {
      agreementId: agreement.id,
      bookingRequestId: args.bookingRequestId,
      reason,
      error: describeError(err),
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "respondToBookingAgreement", step: "agree_mint" },
        extra: {
          agreementId: agreement.id,
          bookingRequestId: args.bookingRequestId,
          reason,
        },
      });
    } catch {
      // Reporting is best-effort — never let it change the outcome.
    }
  };

  const sentBy = agreement.sentForReviewByHumanId;
  if (!sentBy) {
    return degrade(
      new Error("agree_mint_no_terms_sender"),
      "terms_sent_before_sender_was_recorded",
    );
  }
  let eventId: string;
  try {
    const minted = await createEventFromAgreementOnNight(deps, {
      actorHumanId: sentBy,
      agreementId: agreement.id,
      night: {
        calendarId: args.hold.calendarId,
        spaceId: args.hold.spaceId,
        date: args.night,
      },
    });
    eventId = minted.eventId;
  } catch (error) {
    return degrade(error, "mint_threw");
  }
  return eventId;
}

/**
 * The venue's side of the thread says the event was not created (P2b review
 * carry e): a VENUE-INTERNAL `booking_agreement.event_not_created`, in its OWN
 * small transaction (the booking committed already). Best-effort: a failed
 * write is logged at error AND reported, guarded — the agree stands either
 * way and the mint failure itself was already reported.
 */
async function tellVenueEventNotCreated(
  deps: RespondToBookingAgreementDeps,
  args: {
    agreementId: string;
    bookingRequestId: string;
    date: string;
    actorHumanId: string;
    now: Date;
    /** Why the mint did not land (audit only; the entry names no cause). */
    reason: string;
  },
): Promise<void> {
  try {
    await deps.repos.tx(async (tx) => {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: args.bookingRequestId,
        kind: "booking_agreement.event_not_created",
        data: { agreementId: args.agreementId, date: args.date },
        actorHumanId: args.actorHumanId,
      });
      await tx.audit.log({
        entity: "booking_agreement",
        entityId: args.agreementId,
        action: "booking_agreement.event_not_created",
        data: {
          actorHumanId: args.actorHumanId,
          bookingRequestId: args.bookingRequestId,
          date: args.date,
          reason: args.reason,
        },
        at: args.now,
      });
    });
  } catch (error) {
    deps.logger?.error("booking_agreements.event_not_created_record_failed", {
      agreementId: args.agreementId,
      bookingRequestId: args.bookingRequestId,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "respondToBookingAgreement",
          step: "event_not_created_ledger",
        },
        extra: {
          agreementId: args.agreementId,
          bookingRequestId: args.bookingRequestId,
        },
      });
    } catch {
      // Reporting is best-effort.
    }
  }
}

/**
 * The venue is told the agree was refused (N6, "The venue has been told"):
 * a venue-only ledger entry on the thread, in its OWN small transaction (the
 * booking transaction rolled back), plus an in-app ping to the venue party.
 * Both best-effort: the sender's refusal stands whatever happens here; a
 * failed ledger write is logged + reported (the ping reports its own).
 */
async function tellVenueAgreeRefused(
  deps: RespondToBookingAgreementDeps,
  args: {
    agreement: AgreementRecord;
    requestId: string;
    date: string;
    actorHumanId: string;
    venueParty: ReturnType<typeof partyOnSide>;
    now: Date;
    /** Why the agree was refused (the ledger and the ping say which). */
    reason: "night_taken" | AgreeRefusedReason;
  },
): Promise<void> {
  try {
    await deps.repos.tx(async (tx) => {
      await appendBookingSystemEntry(tx, {
        bookingRequestId: args.requestId,
        kind: "booking_agreement.agree_refused",
        data: {
          agreementId: args.agreement.id,
          date: args.date,
          // Rows written before `reason` existed read as "night taken".
          ...(args.reason !== "night_taken" ? { reason: args.reason } : {}),
        },
        actorHumanId: args.actorHumanId,
      });
      await tx.audit.log({
        entity: "booking_agreement",
        entityId: args.agreement.id,
        action: "booking_agreement.agree_refused",
        data: {
          actorHumanId: args.actorHumanId,
          bookingRequestId: args.requestId,
          date: args.date,
          reason:
            args.reason === "night_taken"
              ? "night_no_longer_available"
              : args.reason,
        },
        at: args.now,
      });
    });
  } catch (error) {
    deps.logger?.error("booking_agreements.agree_refused_record_failed", {
      agreementId: args.agreement.id,
      bookingRequestId: args.requestId,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: {
          useCase: "respondToBookingAgreement",
          step: "agree_refused_ledger",
        },
        extra: {
          agreementId: args.agreement.id,
          bookingRequestId: args.requestId,
        },
      });
    } catch {
      // Reporting is best-effort.
    }
  }

  await notifyAgreementParty(deps, {
    party: args.venueParty,
    actorHumanId: args.actorHumanId,
    agreementId: args.agreement.id,
    eventKey: `agree_refused:${args.reason}:${args.date}`,
    ...agreeRefusedPing(args.agreement.title, args.reason),
  });
}

/**
 * The venue's in-app ping for a refused agree. The night is NOT booked when
 * it is sent, so the copy names the request, never "this booking".
 */
function agreeRefusedPing(
  title: string,
  reason: "night_taken" | AgreeRefusedReason,
): { title: string; body: string } {
  switch (reason) {
    case "night_taken":
      return {
        title: "Night no longer available",
        body: `"${title}" could not be agreed: that night is no longer available. Pick another night and send the terms again.`,
      };
    case "event_on_another_night":
      return {
        title: "Event on another day",
        body: `"${title}" could not be agreed: the event for this request is on a different day. Move the event, or send terms for its day.`,
      };
    case "event_origin_gone":
      return {
        title: "Event cancelled or archived",
        body: `"${title}" could not be agreed: the event for this request was cancelled or archived, so the night was not booked.`,
      };
    case "linked_event_gone":
      return {
        title: "Event cancelled or archived",
        body: `"${title}" could not be agreed: the event these terms were finalized for was cancelled or archived, so the night was not booked.`,
      };
    case "place_not_taking_bookings":
      return {
        title: "Not taking bookings",
        body: `"${title}" could not be agreed: this place is suspended or retired, so the night was not booked.`,
      };
  }
}
