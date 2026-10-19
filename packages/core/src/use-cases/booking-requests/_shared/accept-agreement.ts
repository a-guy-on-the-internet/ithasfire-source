import type { TxRepos } from "@th/ports/repos";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import type { EventOwnerSide } from "../../booking-agreements/_shared/event-owner-side";
import {
  addSetLength,
  computeAgreementPitchSeed,
  type AgreementPitchContext,
  type AgreementPitchSource,
} from "../../booking-agreements/_shared/pitch-seed";

// ─────────────────────────────────────────────────────────────────────────────
// Shared accept→Agreement internals (booking-request-embed-button FR-007)
//
// Two call sites mint the Agreement for an accepted booking request and MUST
// stay behaviorally identical:
//   - respond-to-booking-request (owned accept — Agreement minted immediately)
//   - claim-booking-request (anonymous accept deferred the Agreement to claim)
//
// SEEDING FROM THE PITCH. Both mints prefill the header from the originating
// request (`computeAgreementPitchSeed` — see that module for why a money field
// may be seeded and how provenance is derived without a column). The seed is
// computed here, INSIDE the mint, rather than by each caller, so the two
// paths cannot diverge on what an accepted pitch produces; callers supply only
// the venue CONTEXT the pitch is interpreted against, which is the part that
// needs I/O.
// ─────────────────────────────────────────────────────────────────────────────

export type BookingAgreementCounterparty = {
  type: "human" | "organization";
  id: string;
};

/**
 * The venue-side context a pitch is read against, minus the settlement
 * currency — the mint learns that from the PayoutTerms row it just cloned or
 * drafted, so a caller can't get it wrong.
 */
export type AcceptAgreementPitchContext = Omit<
  AgreementPitchContext,
  "settlementCurrency"
>;

export type CreateAcceptAgreementResult = {
  agreementId: string;
  payoutTermsId: string;
  /** Whether the terms were cloned from the place default (vs a bare draft). */
  clonedFromDefaultTerms: boolean;
  /**
   * Requester-owned booking (RENT / USE): whether the single 100% requester
   * line was seeded. `false` when the requester has no payout-ready Payee yet
   * — the draft stays lineless and the agreement editor is where a line lands.
   */
  requesterLineSeeded: boolean;
};

/** Settlement currency of a bare PRIMARY draft (no venue default to inherit). */
const DEFAULT_SETTLEMENT_CURRENCY = "usd";

/**
 * Clone the place's default PRIMARY PayoutTerms into a new PENDING instance
 * (values preserved exactly — no recomputation; lines that require payee
 * confirmation are reset to PENDING), falling back to a bare PENDING PRIMARY
 * draft when the place has no default (or the default row is gone), then
 * create the Agreement DRAFT (proposer = the performer sender, counterparty =
 * the venue side) with the header SEEDED FROM THE PITCH. Must run inside the
 * caller's accept/claim transaction.
 *
 * The seed never touches the PayoutTerms: the cloned/drafted lines are exactly
 * what the venue's defaults say, and a DOOR_SPLIT ask is recorded as prose in
 * the description rather than as an invented percentage (see
 * `pitch-seed.ts`). Nothing here activates terms or skips a review step — the
 * Agreement is DRAFT with PENDING terms either way.
 *
 * OWNER-SIDE TERMS (venue-confirmation spec "Who mints, who owns"): the
 * default owner of the event a booking produces follows the request's intent
 * (`eventOwnerSide`, derived by the caller from `_shared/event-owner-side`).
 * A REQUESTER-owned booking (RENT / USE) gets "100% requester, no venue
 * line": the venue's default terms are NOT cloned (they carry the venue's
 * own lines), a bare PENDING PRIMARY draft is minted, and — when the
 * requester already has an ACTIVE, payout-enabled Payee — a single 100%
 * requester line is seeded onto it. Without a Payee the draft stays lineless
 * (the agreement editor adds the line later; publish's owner-line repair is
 * fenced off for booking-managed terms). The venue may add a door percentage
 * in the editor if negotiated. A later `ownerOverride` at confirm does not
 * reseed: the terms are the negotiation's, edited in the editor.
 */
export async function createAcceptAgreement(
  tx: Pick<TxRepos, "agreements" | "payoutTerms" | "payees">,
  args: {
    place: Pick<PlaceRecord, "id" | "name" | "defaultPrimaryPayoutTermsId">;
    proposerType: PerformerOwnerType;
    proposerId: string;
    counterparty: BookingAgreementCounterparty;
    /** The originating request's pitch fields. */
    pitch: AgreementPitchSource;
    /** Venue zone + routed calendar default — resolved by the caller. */
    pitchContext: AcceptAgreementPitchContext;
    /**
     * Who will own the event this booking produces (default by intent —
     * `defaultEventOwnerSideForIntent`). Omitted = `place` (pre-spec rows).
     */
    eventOwnerSide?: EventOwnerSide;
  },
): Promise<CreateAcceptAgreementResult> {
  const { place, proposerType, proposerId, counterparty } = args;
  const eventOwnerSide = args.eventOwnerSide ?? "place";

  let payoutTermsId: string | null = null;
  let settlementCurrency: string | null = null;
  if (eventOwnerSide === "place" && place.defaultPrimaryPayoutTermsId) {
    const cloned = await tx.payoutTerms.clone({
      sourcePayoutTermsId: place.defaultPrimaryPayoutTermsId,
      isDefault: false,
      resetConfirmations: true,
      statusOverride: "PENDING",
      // Snapshot of the place default: the booked event starts PASS_THROUGH.
      resetFeeMode: true,
    });
    if (cloned) {
      payoutTermsId = cloned.id;
      settlementCurrency = cloned.settlementCurrency ?? null;
    }
  }
  const clonedFromDefaultTerms = payoutTermsId !== null;
  let requesterLineSeeded = false;
  if (payoutTermsId === null) {
    const draft = await tx.payoutTerms.createDraft({
      kind: "PRIMARY",
      settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
    });
    payoutTermsId = draft.id;
    settlementCurrency = DEFAULT_SETTLEMENT_CURRENCY;
    if (eventOwnerSide === "requester") {
      requesterLineSeeded = await seedRequesterOwnerLine(tx, {
        payoutTermsId,
        proposerType,
        proposerId,
      });
    }
  }

  const seed = computeAgreementPitchSeed(args.pitch, {
    ...args.pitchContext,
    settlementCurrency,
  });

  const agreement = await tx.agreements.create({
    type: "PERFORMANCE",
    status: "DRAFT",
    proposerType,
    proposerId,
    counterpartyType: counterparty.type,
    counterpartyId: counterparty.id,
    placeId: place.id,
    payoutTermsId,
    title: `Booking — ${place.name}`,
    proposedDate: seed.proposedDate,
    proposedEndDate: seed.proposedEndDate,
    guaranteeCents: seed.guaranteeCents,
    description: seed.description,
  });

  return {
    agreementId: agreement.id,
    payoutTermsId,
    clonedFromDefaultTerms,
    requesterLineSeeded,
  };
}

/**
 * The requester-owned default: ONE plain 100% line to the requester's Payee
 * (`requiresConfirmation: false`, the same shape publish seeds for a
 * lineless owner draft), on the bare draft just minted. Same payee bar as
 * publish's `seedDefaultOwnerLineForLinelessDraft`: an ACTIVE, payout-enabled
 * Payee for the requester (human or org), else nothing is written and the
 * caller reports `requesterLineSeeded: false`. The draft has zero lines by
 * construction (created a statement ago in this tx), so `seedLinesIfEmpty`'s
 * atomic-if-empty write is the honest primitive here too.
 */
async function seedRequesterOwnerLine(
  tx: Pick<TxRepos, "payoutTerms" | "payees">,
  args: {
    payoutTermsId: string;
    proposerType: PerformerOwnerType;
    proposerId: string;
  },
): Promise<boolean> {
  const payeeRef = await tx.payees.getBySubject({
    type: args.proposerType === "organization" ? "ORGANIZATION" : "HUMAN",
    id: args.proposerId,
  });
  if (!payeeRef) return false;
  const payee = await tx.payees.getById(payeeRef.id);
  if (!payee || payee.status !== "ACTIVE" || !payee.payoutsEnabled) {
    return false;
  }
  return tx.payoutTerms.seedLinesIfEmpty(args.payoutTermsId, [
    {
      payeeId: payee.id,
      percent: 100,
      floorCents: 0,
      capPercent: null,
      priority: 0,
      rounding: "FLOOR",
      requiresConfirmation: false,
    },
  ]);
}

/**
 * Mint the Agreement for an ACCEPTED organizer→performer request
 * (organizer-booking-requests FR-005). Diverges from the TO_VENUE mint
 * deliberately:
 * - proposer = the ORGANIZER ORG (the side that asked), counterparty = the
 *   act's owner — the mirror of the TO_VENUE party layout;
 * - payout terms are ALWAYS a bare PENDING PRIMARY draft — there is no venue
 *   default to clone in this direction (the org's own defaults describe
 *   events it runs, not deals it proposes);
 * - placeId comes from the ATTACHED EVENT's venue when one is present, else
 *   null (the request itself never carries a venue — DB CHECK);
 * - proposedDate/proposedEndDate PREFER the attached event (user decision
 *   2026-07-21: "event startsAt wins over preferredDates[0]"), falling back to
 *   the pitch seed when no event is attached — the same fallback the venue
 *   direction uses. The precedence the decision settled is preserved
 *   exactly; only the previously-empty no-event case changes, and it changes
 *   from "the org's stated dates are dropped" to "they are the opening
 *   position, labelled as such". An attached event with no END still borrows
 *   the pitch's set length, which adds information without contradicting the
 *   event;
 * - title is "Booking — {act name}" (the venue flow titles by place).
 *
 * Must run inside the caller's accept transaction.
 */
export async function createOrganizerAcceptAgreement(
  tx: Pick<TxRepos, "agreements" | "payoutTerms">,
  args: {
    organizerOrgId: string;
    performerOwnerType: PerformerOwnerType;
    performerOwnerId: string;
    /** Resolved, non-empty act display name (see `_shared/act-name.ts`). */
    actName: string;
    /**
     * The attached event's live details at accept time, or null when none was
     * attached (or it has since been deleted — SetNull detaches).
     */
    attachedEvent: {
      placeId: string | null;
      startsAt: Date;
      endsAt: Date | null;
    } | null;
    /** The organizer request's pitch fields. */
    pitch: AgreementPitchSource;
    /**
     * Venue zone + calendar default. This direction has no venue anchor of its
     * own, so the caller passes the platform default zone and a null calendar
     * default — organizer→act requests are never calendar-routed.
     */
    pitchContext: AcceptAgreementPitchContext;
  },
): Promise<CreateAcceptAgreementResult> {
  const draft = await tx.payoutTerms.createDraft({
    kind: "PRIMARY",
    settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
  });

  const seed = computeAgreementPitchSeed(args.pitch, {
    ...args.pitchContext,
    settlementCurrency: DEFAULT_SETTLEMENT_CURRENCY,
  });

  // The attached event is the harder fact — it already exists on a calendar —
  // so it wins the start. The end falls through event → pitch set length →
  // null.
  const proposedDate = args.attachedEvent?.startsAt ?? seed.proposedDate;
  const proposedEndDate =
    args.attachedEvent?.endsAt ??
    (args.attachedEvent
      ? // The event overruled the pitch's DATE, so the set length is measured
        // from the event's start instead — same span rule, different anchor.
        addSetLength(args.attachedEvent.startsAt, args.pitch.setLengthMinutes)
      : seed.proposedEndDate);

  const agreement = await tx.agreements.create({
    type: "PERFORMANCE",
    status: "DRAFT",
    proposerType: "organization",
    proposerId: args.organizerOrgId,
    counterpartyType: args.performerOwnerType,
    counterpartyId: args.performerOwnerId,
    placeId: args.attachedEvent?.placeId ?? null,
    payoutTermsId: draft.id,
    title: `Booking — ${args.actName}`,
    proposedDate,
    proposedEndDate,
    guaranteeCents: seed.guaranteeCents,
    description: seed.description,
  });

  return {
    agreementId: agreement.id,
    payoutTermsId: draft.id,
    clonedFromDefaultTerms: false,
    requesterLineSeeded: false,
  };
}

/**
 * Venue counterparty for a CLAIM-time Agreement, where no venue actor is
 * present (the performer redeems the link).
 *
 * DIVERGES from the owned-accept precedence — deliberately. At respond time,
 * `deriveCounterparty` follows the responding ACTOR's access path, and
 * `requirePlaceOwnership` checks `humanIdsWithAccess` first, so a dual-access
 * actor (direct human owner who is also an owning-org member) yields a HUMAN
 * counterparty. Here there is no actor, so we prefer the ORG whenever one
 * owns the place (the org is the durable business entity a booking agreement
 * should hang off), falling back to a direct human owner. The divergence is
 * acceptable because every candidate is a verified owner of the SAME place
 * and the Agreement is minted DRAFT with PENDING terms — the venue side
 * reviews/edits before anything binds.
 *
 * Determinism: the access lists come from an unordered ownership filter in
 * the places adapter, so a bare `[0]` would be nondeterministic across
 * reads. Pick the lexicographically smallest id so repeated claims (and
 * anyone debugging one) always see the same counterparty.
 */
export function deriveVenueCounterpartyFromPlace(
  place: Pick<PlaceRecord, "id" | "orgIdsWithAccess" | "humanIdsWithAccess">,
): BookingAgreementCounterparty {
  const orgId = [...place.orgIdsWithAccess].sort()[0];
  if (orgId) return { type: "organization", id: orgId };
  const humanId = [...place.humanIdsWithAccess].sort()[0];
  if (humanId) return { type: "human", id: humanId };
  // A place with no owner at all can't anchor an Agreement — corrupt/edge
  // state, surfaced as the same conflict family the accept path uses.
  throw fail("INVALID_STATUS", {
    meta: { reason: "place_has_no_owner", placeId: place.id },
  });
}
