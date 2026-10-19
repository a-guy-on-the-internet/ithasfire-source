import { z } from "zod";

import { eventStatusSchema } from "@th/schema";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE, ORG_EDIT_ROLES } from "../../lib/rbac";
import { bookingRequestStatusSchema } from "../booking-requests/list-booking-requests";
import {
  bookingRequestBillItemSchema,
  resolveBillIdentities,
  toBillItems,
  type BookingRequestBillItem,
} from "../booking-requests/_shared/bill-items";
import { fail } from "@th/errors";
import {
  requireAgreementParty,
  type AgreementParty,
} from "./_shared/agreement-access";
import { guaranteeIsSetByDeal } from "./_shared/agreement-deal-guarantee";
import { termsSideForRequest } from "./_shared/agreement-editor-side";
import {
  DEFAULT_BOOKING_TIMEZONE,
  deriveAgreementPitchProvenance,
  parsePreferredDateEntry,
  resolveBookingTimezone,
  resolveCalendarDefaultStartTime,
  type AgreementPitchProvenance,
} from "./_shared/pitch-seed";
import {
  agreementPartyTypeSchema,
  agreementStatusSchema,
  partyKey,
  resolvePartyDisplayNames,
} from "./list-booking-agreements";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const payoutLineConfirmationStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "COUNTERED",
  "DECLINED",
]);

export const bookingAgreementLineSchema = z
  .object({
    id: z.uuid(),
    payeeId: z.uuid(),
    /** Payee subject coordinates (null when the payee row is gone). */
    subjectType: agreementPartyTypeSchema.nullable(),
    subjectId: z.uuid().nullable(),
    displayName: z.string().nullable(),
    payeeStatus: z.enum(["PENDING", "ACTIVE", "RESTRICTED"]).nullable(),
    percent: z.number().int(),
    floorCents: z.number().int(),
    capPercent: z.number().int().nullable(),
    priority: z.number().int(),
    requiresConfirmation: z.boolean(),
    confirmationStatus: payoutLineConfirmationStatusSchema.nullable(),
    confirmedAt: z.date().nullable(),
    /** The payee's open counter-ask (COUNTERED lines only), in basis points. */
    counterPercentBps: z.number().int().nullable(),
    counterNote: z.string().nullable(),
  })
  .strict();

export const getBookingAgreementInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    agreementId: z.uuid(),
  })
  .strict();

/**
 * Per-field "this is still exactly what the act asked for" (see
 * `_shared/pitch-seed.ts`). Derived, never stored: the value is recomputed
 * from the pitch and compared to the stored header, so it flips to `false` the
 * moment the venue edits that field. `true` is the ONLY signal the UI may use
 * to label a field as coming from the pitch — it must not re-derive one.
 */
export const agreementPitchProvenanceSchema = z
  .object({
    proposedDate: z.boolean(),
    proposedEndDate: z.boolean(),
    guaranteeCents: z.boolean(),
    description: z.boolean(),
  })
  .strict();

export const getBookingAgreementOutputSchema = z
  .object({
    agreement: z
      .object({
        id: z.uuid(),
        type: z.string(),
        status: agreementStatusSchema,
        proposerType: agreementPartyTypeSchema,
        proposerId: z.uuid(),
        proposerDisplayName: z.string().nullable(),
        counterpartyType: agreementPartyTypeSchema,
        counterpartyId: z.uuid(),
        counterpartyDisplayName: z.string().nullable(),
        placeId: z.uuid().nullable(),
        eventId: z.uuid().nullable(),
        payoutTermsId: z.uuid().nullable(),
        title: z.string(),
        description: z.string().nullable(),
        proposedDate: z.date().nullable(),
        proposedEndDate: z.date().nullable(),
        guaranteeCents: z.number().int().nullable(),
        proposedAt: z.date().nullable(),
        acceptedAt: z.date().nullable(),
        declinedAt: z.date().nullable(),
        declinedReason: z.string().nullable(),
        expiresAt: z.date().nullable(),
        fulfilledAt: z.date().nullable(),
        createdAt: z.date(),
        updatedAt: z.date(),
      })
      .strict(),
    lines: z.array(bookingAgreementLineSchema),
    /** The originating pitch, when this agreement came from a request. */
    bookingRequest: z
      .object({
        id: z.uuid(),
        status: bookingRequestStatusSchema,
        message: z.string(),
        preferredDates: z.array(z.string()),
        expectedDraw: z.number().int().nullable(),
        genre: z.string().nullable(),
        links: z.array(z.string()),
        createdAt: z.date(),
      })
      .strict()
      .nullable(),
    /**
     * The originating request's BILL as the VENUE sees it (lineup v3 FR-011,
     * L2) — shown to BOTH parties, read-only: joined acts plain, invited acts
     * marked (`confirmation: "PENDING"`), by-name acts unlinked, passed and
     * removed acts ABSENT, positions renumbered without gaps (the
     * `toBillItems` venue filter, NFR-002). Joined platform acts carry
     * `joinedAs` — the add-line payee picker's "Joined the bill" suggestions;
     * invited acts carry none. `[]` when there is no request or no bill (a
     * TO_PERFORMER request never has one).
     */
    bill: z.array(bookingRequestBillItemSchema),
    /**
     * The bill read failed and `bill` is a degraded `[]` (reported) — so a
     * UI can tell "could not read" from "no bill" and never misstate who is
     * playing. Same contract as the inbox row's flag.
     */
    billUnavailable: z.boolean(),
    /**
     * Which header fields the ACCEPT seeded from that pitch and the venue has
     * not touched since. Null when there is no originating request to
     * attribute anything to.
     */
    pitchProvenance: agreementPitchProvenanceSchema.nullable(),
    /**
     * `agreement.guaranteeCents` comes from The deal (deal-terms-and-settlement
     * FR-001): the agreement is linked to its booking request and its terms
     * carry a deal, so every deal save sets the header to the fixed part of
     * the act's clauses (null when they have none) and `updateHeader` refuses
     * a change (`AGREEMENT_NOT_EDITABLE`, reason `guarantee_set_by_deal`).
     * The UI renders the guarantee read-only, labelled as The deal's. While
     * false, `guaranteeCents` is the typed (or pitch-seeded) header value.
     * When true, `pitchProvenance.guaranteeCents` is false: the number is the
     * deal's, whatever the pitch said.
     */
    guaranteeFromDeal: z.boolean(),
    /**
     * The event this agreement produced, reached the way the inbox reaches
     * it (`listBookingRequests.resolveBookingStages`): `Agreement.eventId`
     * — the finalized link — falling back to `Agreement.draftEventId`, the
     * pre-finalize anchor `createEventFromAgreement` stamps. Finalized WINS
     * on a tie (same precedence as `AgreementsRepo.findByLinkedEventId`).
     *
     * Same encodings as the inbox row's `eventStatus` / `eventStartsAt`, so
     * the booking stage rail gets identical inputs from either surface.
     * ALL-OR-NOTHING: null when there is no linked event, when the linked
     * row no longer resolves, or when the read failed (degraded, reported)
     * — never a half-populated object.
     */
    event: z
      .object({
        id: z.uuid(),
        status: eventStatusSchema,
        startsAt: z.date(),
      })
      .strict()
      .nullable(),
    actorSide: z.enum(["proposer", "counterparty"]),
    /**
     * Which terms-side the viewer is on (`_shared/agreement-editor-side.ts`):
     * `editor` = the venue/organizer (non-act) party, `act` = the performer,
     * `null` = the agreement has no originating request (either party edits).
     */
    viewerSide: z.enum(["editor", "act"]).nullable(),
    /**
     * Status-INDEPENDENT: the viewer has edit-level access on their side AND
     * is not the act. Drives every terms affordance (edit, send for review,
     * pull back, reopen) so the UI never has to guess who the act is.
     */
    viewerCanEditTerms: z.boolean(),
    /** `viewerCanEditTerms` AND the agreement is DRAFT right now. */
    mayEdit: z.boolean(),
  })
  .strict();

export type GetBookingAgreementInput = z.infer<
  typeof getBookingAgreementInputSchema
>;
export type GetBookingAgreementOutput = z.infer<
  typeof getBookingAgreementOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type GetBookingAgreementDeps = {
  repos: Pick<
    Repos,
    | "agreements"
    | "payoutTerms"
    | "payees"
    | "bookingRequests"
    | "authz"
    | "humans"
    | "organizations"
    // Pitch-provenance context: the venue's timezone (places) and the routed
    // calendar's default show time (calendars). Both degradable reads.
    | "places"
    | "calendars"
    // The linked event (stage rail context). Degradable read.
    | "events"
    // The bill's act names + PUBLIC page links (v3 FR-011). Degradable read.
    | "entityPages"
  >;
  logger?: LoggerPort;
  /**
   * Best-effort reporter for the context-read swallows (ReporterPort
   * convention) — a failed places/calendars/payout-terms/linked-event read
   * degrades that field, never the agreement read.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Editor read model: agreement header + hydrated payout lines (payee subject
 * + resolved display name, batched) + the originating booking request, plus
 * which side the actor controls and whether they may edit right now.
 *
 * Viewing is party-gated with ANY org role; `viewerCanEditTerms` additionally
 * requires edit-level access on the actor's side AND that the actor is not
 * the act of the originating request; `mayEdit` adds DRAFT status on top.
 */
export async function getBookingAgreement(
  deps: GetBookingAgreementDeps,
  rawInput: unknown,
): Promise<GetBookingAgreementOutput> {
  const input = parseInput(getBookingAgreementInputSchema, rawInput);

  const agreement = await deps.repos.agreements.getById(input.agreementId);
  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }

  const party = await requireAgreementParty(deps.repos, {
    agreement,
    actorHumanId: input.actorHumanId,
    orgRoles: ORG_ANY_ROLE,
  });

  const bookingRequest = await deps.repos.bookingRequests.findByAgreementId(
    agreement.id,
  );

  const hasEditRole =
    party.via === "human" ||
    (party.orgRole !== null && ORG_EDIT_ROLES.includes(party.orgRole));
  const viewerSide = termsSideForRequest(bookingRequest, agreement, party.side);
  const viewerCanEditTerms = hasEditRole && viewerSide !== "act";
  const mayEdit = agreement.status === "DRAFT" && viewerCanEditTerms;

  const lineRecords = agreement.payoutTermsId
    ? await deps.repos.payoutTerms.listLines(agreement.payoutTermsId)
    : [];

  const payees = lineRecords.length
    ? await deps.repos.payees.getByIds(lineRecords.map((l) => l.payeeId))
    : [];
  const payeesById = new Map(payees.map((payee) => [payee.id, payee]));

  const nameRefs: AgreementParty[] = [
    { type: agreement.proposerType, id: agreement.proposerId },
    { type: agreement.counterpartyType, id: agreement.counterpartyId },
    ...payees.map(
      (payee): AgreementParty => ({
        type: payee.subjectType === "HUMAN" ? "human" : "organization",
        id: payee.subjectId,
      }),
    ),
  ];
  const displayNames = await resolvePartyDisplayNames(deps.repos, nameRefs);

  // FR-001: is the header guarantee The deal's? Not degradable: a wrong
  // answer would offer an edit the header write then refuses.
  const guaranteeFromDeal =
    bookingRequest !== null && agreement.payoutTermsId !== null
      ? guaranteeIsSetByDeal(
          await deps.repos.payoutTerms.getById(agreement.payoutTermsId),
          true,
        )
      : false;

  const seededProvenance = bookingRequest
    ? await resolvePitchProvenance(deps, agreement, bookingRequest)
    : null;
  const pitchProvenance =
    seededProvenance && guaranteeFromDeal
      ? { ...seededProvenance, guaranteeCents: false }
      : seededProvenance;

  const event = await resolveLinkedEvent(deps, agreement);

  const billRead = await resolveVenueFacingBill(deps, bookingRequest);

  return getBookingAgreementOutputSchema.parse({
    agreement: {
      id: agreement.id,
      type: agreement.type,
      status: agreement.status,
      proposerType: agreement.proposerType,
      proposerId: agreement.proposerId,
      proposerDisplayName:
        displayNames.get(
          partyKey(agreement.proposerType, agreement.proposerId),
        ) ?? null,
      counterpartyType: agreement.counterpartyType,
      counterpartyId: agreement.counterpartyId,
      counterpartyDisplayName:
        displayNames.get(
          partyKey(agreement.counterpartyType, agreement.counterpartyId),
        ) ?? null,
      placeId: agreement.placeId,
      eventId: agreement.eventId,
      payoutTermsId: agreement.payoutTermsId,
      title: agreement.title,
      description: agreement.description,
      proposedDate: agreement.proposedDate,
      proposedEndDate: agreement.proposedEndDate,
      guaranteeCents: agreement.guaranteeCents,
      proposedAt: agreement.proposedAt,
      acceptedAt: agreement.acceptedAt,
      declinedAt: agreement.declinedAt,
      declinedReason: agreement.declinedReason,
      expiresAt: agreement.expiresAt,
      fulfilledAt: agreement.fulfilledAt,
      createdAt: agreement.createdAt,
      updatedAt: agreement.updatedAt,
    },
    lines: lineRecords.map((line) => {
      const payee = payeesById.get(line.payeeId) ?? null;
      const subjectType = payee
        ? payee.subjectType === "HUMAN"
          ? ("human" as const)
          : ("organization" as const)
        : null;
      return {
        id: line.id,
        payeeId: line.payeeId,
        subjectType,
        subjectId: payee?.subjectId ?? null,
        displayName:
          payee && subjectType
            ? (displayNames.get(partyKey(subjectType, payee.subjectId)) ?? null)
            : null,
        payeeStatus: payee?.status ?? null,
        percent: line.percent,
        floorCents: line.floorCents,
        capPercent: line.capPercent,
        priority: line.priority,
        requiresConfirmation: line.requiresConfirmation,
        confirmationStatus: line.confirmationStatus,
        confirmedAt: line.confirmedAt,
        counterPercentBps: line.counterPercentBps,
        counterNote: line.counterNote,
      };
    }),
    bookingRequest: bookingRequest
      ? {
          id: bookingRequest.id,
          status: bookingRequest.status,
          message: bookingRequest.message,
          preferredDates: bookingRequest.preferredDates,
          expectedDraw: bookingRequest.expectedDraw,
          genre: bookingRequest.genre,
          links: bookingRequest.links,
          createdAt: bookingRequest.createdAt,
        }
      : null,
    bill: billRead.bill,
    billUnavailable: billRead.unavailable,
    pitchProvenance,
    guaranteeFromDeal,
    event,
    actorSide: party.side,
    viewerSide,
    viewerCanEditTerms,
    mayEdit,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pitch provenance (derived, not stored)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute the accept-time seed and report which header fields still hold it.
 *
 * This is the ONE place the answer is produced. `pitch-seed.ts` owns the rule
 * (the same function the accept mint used), this resolves the venue CONTEXT it
 * needs, and the UI consumes booleans — so a label can never disagree with
 * what was actually seeded.
 *
 * Every read here is DEGRADABLE: a failed places/calendars/payoutTerms lookup
 * costs at most a provenance label. Losing the label is invisible; failing an
 * agreement page because a timezone lookup hiccuped is not. Each swallow is
 * error-logged AND reported (ReporterPort convention, guarded).
 */
async function resolvePitchProvenance(
  deps: GetBookingAgreementDeps,
  agreement: AgreementRecord,
  request: BookingRequestRecord,
): Promise<AgreementPitchProvenance> {
  const [timezone, settlementCurrency] = await Promise.all([
    resolveVenueTimezone(deps, agreement.placeId),
    resolveSettlementCurrency(deps, agreement.payoutTermsId),
  ]);

  // The routed calendar only supplies a default show time, which a pitch that
  // named its own time never consults — skip the read entirely in that case
  // (and when there is no venue to route against).
  const needsCalendarDefault =
    agreement.placeId !== null &&
    request.calendarId !== null &&
    parsePreferredDateEntry(request.preferredDates[0] ?? "")?.time == null;

  const calendarDefaultStartTime = needsCalendarDefault
    ? await resolveCalendarDefaultStartTime(
        { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
        { placeId: agreement.placeId!, calendarId: request.calendarId },
      )
    : null;

  return deriveAgreementPitchProvenance(agreement, request, {
    timezone,
    calendarDefaultStartTime,
    settlementCurrency,
  });
}

/** Venue zone for the anchor, falling back to the platform default. */
async function resolveVenueTimezone(
  deps: GetBookingAgreementDeps,
  placeId: string | null,
): Promise<string> {
  if (!placeId) return DEFAULT_BOOKING_TIMEZONE;
  try {
    const place = await deps.repos.places.getById(placeId);
    return resolveBookingTimezone(place?.timezone ?? null);
  } catch (error) {
    reportProvenanceDegrade(deps, error, "place_lookup_failed", {
      agreementPlaceId: placeId,
    });
    return DEFAULT_BOOKING_TIMEZONE;
  }
}

/**
 * The terms' settlement currency, or null when it can't be established —
 * `computeAgreementPitchSeed` treats null as "cannot verify" and refuses to
 * attribute a guarantee, which is the safe direction for a money label.
 */
async function resolveSettlementCurrency(
  deps: GetBookingAgreementDeps,
  payoutTermsId: string | null,
): Promise<string | null> {
  if (!payoutTermsId) return null;
  try {
    const terms = await deps.repos.payoutTerms.getById(payoutTermsId);
    return terms?.settlementCurrency ?? null;
  } catch (error) {
    reportProvenanceDegrade(deps, error, "payout_terms_lookup_failed", {
      payoutTermsId,
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The bill (lineup v3 FR-011)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The originating request's live bill, VENUE-FACING for both parties (see
 * the output schema): ONE act read + ONE identity pass, none when there is
 * no TO_VENUE request. The venue filter is the inbox's own (`toBillItems`
 * with `hideDeclined`), so the agreement can never show the venue more than
 * its inbox does — and the sender, who sees passed acts struck in the inbox,
 * sees here exactly what the venue was shown.
 *
 * DEGRADABLE like the context reads above: a failed read costs the bill
 * section (`unavailable: true`), never the agreement page. Error-logged AND
 * reported (ReporterPort convention, guarded).
 */
async function resolveVenueFacingBill(
  deps: GetBookingAgreementDeps,
  request: BookingRequestRecord | null,
): Promise<{ bill: BookingRequestBillItem[]; unavailable: boolean }> {
  if (!request || request.direction !== "TO_VENUE") {
    return { bill: [], unavailable: false };
  }
  try {
    const acts = await deps.repos.bookingRequests.listActsForRequests([
      request.id,
    ]);
    if (acts.length === 0) return { bill: [], unavailable: false };
    const identities = await resolveBillIdentities(deps.repos, acts);
    return {
      bill: toBillItems(acts, identities, { hideDeclined: true }),
      unavailable: false,
    };
  } catch (error) {
    reportProvenanceDegrade(deps, error, "bill_lookup_failed", {
      bookingRequestId: request.id,
    });
    return { bill: [], unavailable: true };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linked event (stage rail context)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The event triple the stage rail renders, resolved from the agreement's
 * link columns with the finalized link winning. ONE `events.getById` at most,
 * none when neither link is set.
 *
 * DEGRADABLE like the provenance context reads: a failed event lookup costs
 * the rail's last stage, not the agreement page. The rail treats null as
 * "nothing to show" (same contract as the inbox's NO_STAGE), never as a wrong
 * stage. Error-logged AND reported (ReporterPort convention, guarded).
 */
async function resolveLinkedEvent(
  deps: GetBookingAgreementDeps,
  agreement: AgreementRecord,
): Promise<GetBookingAgreementOutput["event"]> {
  const linkedEventId = agreement.eventId ?? agreement.draftEventId;
  if (!linkedEventId) return null;
  try {
    const event = await deps.repos.events.getById(linkedEventId);
    if (!event) return null;
    return { id: event.id, status: event.status, startsAt: event.startsAt };
  } catch (error) {
    reportProvenanceDegrade(deps, error, "linked_event_lookup_failed", {
      agreementId: agreement.id,
      linkedEventId,
    });
    return null;
  }
}

function reportProvenanceDegrade(
  deps: GetBookingAgreementDeps,
  error: unknown,
  reason: string,
  extra: Record<string, unknown>,
): void {
  deps.logger?.error("booking_agreements.context_read_degraded", {
    reason,
    ...extra,
    err: error,
  });
  try {
    deps.reportError?.(error, {
      tags: { useCase: "getBookingAgreement" },
      extra: { reason, ...extra },
    });
  } catch {
    // Reporting is best-effort — a throwing reporter must never turn a missing
    // provenance label into a failed agreement read.
  }
}
