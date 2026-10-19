// Two-party booking Agreement (agreement.prisma `Agreement` model).
//
// NOT to be confused with the PayoutTerms "agreements" engine
// (packages/core/src/use-cases/agreements/), which authors PayoutTermsLine
// money splits. This is the negotiation header that *links* to a PayoutTerms
// instance via `payoutTermsId`.

/** Polymorphic party — "human" | "organization" (app-enforced). */
export type AgreementPartyType = "human" | "organization";

export type AgreementType =
  | "PERFORMANCE"
  | "VENUE_RENTAL"
  | "SERVICES"
  | "REVENUE_SHARE"
  | "CUSTOM";

export type AgreementStatus =
  | "DRAFT"
  | "PROPOSED"
  | "COUNTERED"
  | "ACCEPTED"
  | "DECLINED"
  | "CANCELLED"
  | "FULFILLED"
  | "EXPIRED"
  | "DISPUTED";

export interface AgreementRecord {
  id: string;
  type: AgreementType;
  status: AgreementStatus;
  proposerType: AgreementPartyType;
  proposerId: string;
  counterpartyType: AgreementPartyType;
  counterpartyId: string;
  placeId: string | null;
  eventId: string | null;
  /**
   * DRAFT event minted by `createEventFromAgreement` BEFORE finalize stamps
   * `eventId` (booking-conversation-and-event-step FR-006). Idempotency
   * anchor: a repeat create returns this event instead of minting another.
   * `eventId`-set still means "finalized" everywhere — never read this field
   * as a finalize signal.
   */
  draftEventId: string | null;
  payoutTermsId: string | null;
  title: string;
  description: string | null;
  proposedDate: Date | null;
  proposedEndDate: Date | null;
  guaranteeCents: number | null;
  proposedAt: Date | null;
  acceptedAt: Date | null;
  declinedAt: Date | null;
  declinedReason: string | null;
  expiresAt: Date | null;
  fulfilledAt: Date | null;
  /**
   * The venue person who last sent these terms for the sender to agree
   * (booking-the-night FR-002). The agree-time mint runs as this human, with
   * their authority re-checked then (N10). Null before the first send, on
   * rows sent before the column existed, and after the human is deleted.
   */
  sentForReviewByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAgreementInput {
  type: AgreementType;
  /** Defaults to DRAFT. */
  status?: AgreementStatus;
  proposerType: AgreementPartyType;
  proposerId: string;
  counterpartyType: AgreementPartyType;
  counterpartyId: string;
  placeId?: string | null;
  payoutTermsId?: string | null;
  title: string;
  description?: string | null;
  proposedDate?: Date | null;
  proposedEndDate?: Date | null;
  /** Integer cents — never floats. */
  guaranteeCents?: number | null;
}

/**
 * Header field update. `undefined` = leave unchanged; `null` clears a
 * nullable column. Applied as a guarded compare-and-swap: the write only
 * lands while the row's status is still in `expectedFrom` (see
 * `AgreementsRepo.updateHeader`).
 */
export interface UpdateAgreementHeaderInput {
  id: string;
  expectedFrom: readonly AgreementStatus[];
  title?: string;
  description?: string | null;
  proposedDate?: Date | null;
  proposedEndDate?: Date | null;
  /** Integer cents — never floats. */
  guaranteeCents?: number | null;
  expiresAt?: Date | null;
}

/**
 * Stamp the draft-event anchor (`Agreement.draftEventId`) minted by
 * `createEventFromAgreement`. Guarded compare-and-swap: the write only lands
 * while status is still in `expectedFrom` AND `draftEventId IS NULL` AND
 * `eventId IS NULL` — a concurrent create/finalize/cancel matches zero rows
 * and the adapter throws
 * `{ code: "conflict", message: "agreement_status_changed" }`. (After an
 * event deletion, the FK's SetNull re-opens the anchor so a fresh draft can
 * be stamped.)
 */
export interface SetAgreementDraftEventInput {
  id: string;
  draftEventId: string;
  expectedFrom: readonly AgreementStatus[];
  /**
   * Swap a DEAD anchor instead of requiring an empty one: the CAS matches
   * `draftEventId = replacingDraftEventId` rather than `IS NULL`. A
   * CANCELLED/ARCHIVED draft keeps its link (only a delete SetNulls it), so
   * a fresh mint over it must name the row it replaces. Omit/null = the
   * plain anchor-free stamp.
   */
  replacingDraftEventId?: string | null;
}

export interface ListAgreementsByPartyInput {
  partyType: AgreementPartyType;
  partyId: string;
  statuses?: AgreementStatus[];
}

/**
 * Guarded status transition (mirrors BookingRequest's `updateStatus`): the
 * WHERE re-checks `status ∈ expectedFrom` at write time so a concurrent
 * transition can't be clobbered. When `eventId` is provided the CAS
 * additionally requires the stored `eventId` to be NULL — the finalize
 * double-link guard.
 */
export interface UpdateAgreementStatusInput {
  id: string;
  status: AgreementStatus;
  expectedFrom: readonly AgreementStatus[];
  proposedAt?: Date | null;
  acceptedAt?: Date | null;
  declinedAt?: Date | null;
  declinedReason?: string | null;
  fulfilledAt?: Date | null;
  /**
   * Record who sent the terms (booking-the-night FR-002), in the SAME guarded
   * write as the DRAFT → PROPOSED transition, so the stamp can never land on
   * a send that lost its CAS. `undefined` leaves the column as is; the send
   * passes the actor and every other transition omits it.
   *
   * Going back to DRAFT (pull back, N16's declined-terms-to-draft) also uses
   * this method — `status: "DRAFT", expectedFrom: ["PROPOSED"]` is the CAS
   * "return to draft"; there is no separate method for it.
   */
  sentForReviewByHumanId?: string | null;
  /** Stamp `Agreement.eventId` (finalize). Never used to clear the link. */
  eventId?: string;
  /**
   * Retire the draft-event anchor in the same guarded write (finalize to a
   * hand-picked event that ISN'T the minted draft): a later `eventId`
   * SetNull (linked event deleted) must not resurrect a stale draft through
   * `createEventFromAgreement`'s anchor short-circuit. The draft EVENT row
   * itself is untouched — it's the venue's to keep or delete.
   */
  clearDraftEventId?: boolean;
  /**
   * Require the stored `draftEventId` to still be exactly this value (null =
   * still no anchor) — booking-the-night P2d-2, carry b. Finalize decides
   * `clearDraftEventId` and the "two live events" refusal from an in-tx
   * re-read; a mint's `setDraftEvent` committing between that re-read and
   * this write would otherwise slip a live anchor in beside the linked
   * event. With this fence the write matches zero rows instead
   * (`agreement_status_changed`). `undefined` = no fence.
   */
  expectedDraftEventId?: string | null;
  /**
   * Require the stored `eventId` to still be NULL without stamping one —
   * the reopen fence: finalize keeps the row on ACCEPTED while stamping
   * `eventId`, so a status-only CAS can't see it. Implied when `eventId`
   * is provided.
   */
  expectEventIdNull?: boolean;
}
