import type {
  AgreementRecord,
  CreateAgreementInput,
  ListAgreementsByPartyInput,
  SetAgreementDraftEventInput,
  UpdateAgreementHeaderInput,
  UpdateAgreementStatusInput,
} from "@th/types/repos/agreements";

/**
 * Two-party booking Agreement (agreement.prisma `Agreement` model).
 *
 * Distinct from `PayoutTermsRepo` and the PayoutTerms-lines engine in
 * `packages/core/src/use-cases/agreements/` — this repo owns the negotiation
 * header that links a performer and a venue side and points at a PayoutTerms
 * instance via `payoutTermsId`.
 */
export interface AgreementsRepo {
  getById(id: string): Promise<AgreementRecord | null>;
  /** The agreement linked to an event, if any (`Agreement.eventId` is unique). */
  getByEventId(eventId: string): Promise<AgreementRecord | null>;
  /**
   * The agreement anchored on an event through EITHER link column — the
   * FINALIZED link (`Agreement.eventId`) or the pre-finalize draft anchor
   * (`Agreement.draftEventId`, stamped by `createEventFromAgreement`).
   *
   * Exists because {@link getByEventId} alone is blind to the state an event
   * spends most of its life in when it came out of a booking: minted as a
   * DRAFT under the anchor, with `eventId` still NULL until a finalize that
   * can stay blocked on payout readiness indefinitely. Provenance reads
   * (`getEventProvenance`) must resolve both, so this is the inverse of the
   * whole booking chain, not just its last hop.
   *
   * PRECEDENCE IS PART OF THE CONTRACT: the finalized link WINS. Both columns
   * are unique, but the same event can legitimately be agreement A's stale
   * draft and agreement B's finalized event (A stamps `draftEventId`, then a
   * venue hand-picks that event in B's FinalizeDialog — B's own
   * `getByEventId` precheck sees nothing, because A links by the draft
   * column). Answering with the money link is the only defensible pick, so
   * implementations MUST probe `eventId` first and only fall back to
   * `draftEventId` on a miss — never a single `OR`, whose row order is
   * unspecified.
   *
   * Cost: ONE unique-index lookup for a finalized event, TWO for a draft
   * (the fallback runs only on a miss). Never a scan, never a loop.
   */
  findByLinkedEventId(eventId: string): Promise<AgreementRecord | null>;
  /**
   * Batch twin of {@link findByLinkedEventId} for list surfaces (the
   * `/my-lineups` page): every agreement whose finalized `eventId` OR
   * pre-finalize `draftEventId` is in `eventIds`, in ONE query. Order is
   * unspecified and one event may match two rows (one agreement's finalized
   * event, another's stale draft anchor), so the CALLER applies the single
   * read's precedence per event: the finalized link first. `[]` → `[]`
   * without a round trip. NOT an authorization boundary.
   */
  findManyByLinkedEventIds(
    eventIds: readonly string[],
  ): Promise<AgreementRecord[]>;
  /**
   * Batch-fetch agreements by id — ONE query for a whole page. Missing ids are
   * silently omitted (same contract as `EventsRepo.findManyByIds`), so callers
   * must treat an absent id as "no agreement" rather than assuming positional
   * alignment; order is unspecified.
   *
   * Exists for list surfaces that project agreement state onto rows they
   * already hold (the booking inbox's stage rail): the ids come from
   * already-authorized rows, and a per-row `getById` would be an N+1 on a page
   * that can span 100 venues. NOT an authorization boundary — it answers for
   * any id handed to it, exactly like `getById`.
   */
  findManyByIds(ids: string[]): Promise<AgreementRecord[]>;
  /**
   * The agreement that owns a PayoutTerms instance, if any. Used as a fence:
   * PayoutTerms referenced by a two-party Agreement are managed exclusively
   * by the booking-agreements use cases (party RBAC + confirmation
   * lifecycle); the legacy PayoutTerms engine must refuse to touch them.
   */
  getByPayoutTermsId(payoutTermsId: string): Promise<AgreementRecord | null>;
  create(input: CreateAgreementInput): Promise<AgreementRecord>;
  /**
   * Header field update with a write-time status CAS. Throws
   * `{ code: "conflict", message: "agreement_status_changed" }` when the row
   * already left `expectedFrom` (lost-update race).
   */
  updateHeader(input: UpdateAgreementHeaderInput): Promise<AgreementRecord>;
  /**
   * Agreements where the party is the proposer OR the counterparty.
   * Newest-updated first.
   */
  listByParty(input: ListAgreementsByPartyInput): Promise<AgreementRecord[]>;
  /**
   * Guarded status transition. Throws
   * `{ code: "conflict", message: "agreement_status_changed" }` when the row
   * already left `expectedFrom`, and
   * `{ code: "event_already_has_agreement" }` when stamping `eventId` trips
   * the unique constraint (another agreement already linked to that event).
   * Also the "return to draft" CAS (PROPOSED → DRAFT) and the carrier of the
   * send's actor stamp (`sentForReviewByHumanId`, booking-the-night FR-002);
   * an actor id that names no Human (deleted mid-send) throws
   * `{ code: "conflict", message: "agreement_sender_missing" }` and writes
   * nothing.
   */
  updateStatus(input: UpdateAgreementStatusInput): Promise<AgreementRecord>;
  /**
   * Stamp the draft-event anchor (see {@link SetAgreementDraftEventInput}).
   * CAS: status ∈ `expectedFrom` AND `draftEventId IS NULL` (or, with
   * `replacingDraftEventId`, `draftEventId = <that id>` — a dead
   * CANCELLED/ARCHIVED anchor being swapped for a fresh mint) AND
   * `eventId IS NULL`; zero rows → `{ code: "conflict", message:
   * "agreement_status_changed" }`. A P2002 on the unique `draftEventId`
   * (the event is already another agreement's draft — unreachable when every
   * create mints a fresh event) maps to the same conflict shape.
   */
  setDraftEvent(input: SetAgreementDraftEventInput): Promise<AgreementRecord>;
}

export type {
  AgreementPartyType,
  AgreementRecord,
  AgreementStatus,
  AgreementType,
  CreateAgreementInput,
  ListAgreementsByPartyInput,
  SetAgreementDraftEventInput,
  UpdateAgreementHeaderInput,
  UpdateAgreementStatusInput,
} from "@th/types/repos/agreements";
