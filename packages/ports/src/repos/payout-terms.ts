import type {
  ActivatePayoutTermsInput,
  ArchivePayoutTermsInput,
  PayoutLineConfirmationStatus,
  PayoutTermsKind,
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
  PayoutTermsLineRounding,
  PayoutTermsRecord,
  PayoutTermsStatus,
  PayoutSchedule,
  CreatePayoutTermsDraftInput,
  UpdatePayoutTermsDraftInput,
  UpdatePayoutLineConfirmationInput,
  ProvisionDefaultPrimaryInput,
} from "@th/types/repos/payout-terms";

export interface PayoutTermsRepo {
  getById(payoutTermsId: string): Promise<PayoutTermsRecord | null>;
  listByEvent(eventId: string): Promise<PayoutTermsRecord[]>;
  /**
   * {@link PayoutTermsRepo.listByEvent} for many events in a fixed number of
   * queries (not one per event): eventId → the event's primary and resale
   * terms, in that order. Events that do not exist or carry no terms map to
   * `[]`. Exists for listing pages that price N events at once.
   */
  listByEventIds(
    eventIds: readonly string[],
  ): Promise<Map<string, PayoutTermsRecord[]>>;
  /**
   * {@link PayoutTermsRepo.listLines} for many terms rows in ONE query:
   * payoutTermsId → its lines, each list in `listLines`' order (priority asc,
   * id asc). Ids with no lines map to `[]`.
   */
  listLinesByTermsIds(
    payoutTermsIds: readonly string[],
  ): Promise<Map<string, PayoutTermsLineRecord[]>>;
  createDraft(input: CreatePayoutTermsDraftInput): Promise<PayoutTermsRecord>;
  /**
   * Atomically create an ACTIVE PRIMARY PayoutTerms with a single 100% owner
   * line in one write. Used to auto-provision an organizer's default payout
   * agreement at publish time when none exists yet. See
   * `ProvisionDefaultPrimaryInput`.
   */
  provisionDefaultPrimary(
    input: ProvisionDefaultPrimaryInput,
  ): Promise<PayoutTermsRecord>;
  updateDraft(input: UpdatePayoutTermsDraftInput): Promise<PayoutTermsRecord>;
  /**
   * Guarded compare-and-swap status transition to ACTIVE (mirrors
   * `AgreementsRepo.updateStatus` / `updateLineConfirmation`): the write only
   * lands when the stored `status` is in `expectedFrom`. Returns the updated
   * record, or `null` when the CAS matched no row (status not in
   * `expectedFrom`, or the row no longer exists) — callers re-read and decide
   * whether the miss is benign (concurrently activated) or fatal.
   *
   * Activation marks organizer-authored PENDING terms as validated-in-force.
   * It happens at exactly two points: event publish (after every publish gate
   * has passed) and booking-agreement finalize (terms linked by an ACCEPTED
   * agreement). ARCHIVED rows must never be activated — callers pass
   * `expectedFrom: ["PENDING"]`.
   */
  activate(input: ActivatePayoutTermsInput): Promise<PayoutTermsRecord | null>;
  /**
   * Guarded compare-and-swap status transition to ARCHIVED — the mirror of
   * {@link activate}: the write only lands when the stored `status` is in
   * `expectedFrom`; `null` when the CAS matched no row (already archived, a
   * concurrent transition, or the row is gone).
   *
   * Deactivation happens at exactly one point today: Cancel booking
   * (booking-the-night FR-009) archives the cancelled agreement's OWN terms
   * — a per-agreement clone, never an org / place / human default — so no
   * payout lines stay ACTIVE on a cancelled event. Rows stay readable
   * (settlement reads terms by id regardless of status); ARCHIVED only takes
   * them out of every "in force" gate (publish, finalize's activation).
   */
  archive(input: ArchivePayoutTermsInput): Promise<PayoutTermsRecord | null>;
  replaceLines(
    payoutTermsId: string,
    lines: PayoutTermsLineInput[],
  ): Promise<void>;
  /**
   * Atomically insert `lines` ONLY if the terms row still has zero lines.
   * The emptiness check and the insert happen in a single statement
   * (`INSERT … SELECT … WHERE NOT EXISTS`), so — unlike a read-then-
   * `replaceLines` sequence — a splits save that commits between the
   * caller's read and this write can never be clobbered by the seed.
   *
   * Used exclusively by publish-time repair of lineless PENDING drafts (the
   * shells the since-removed `setEventFeeMode` auto-created; existing rows
   * can still carry them). Returns `true` when the seed
   * landed; `false` when lines already existed at write time — the caller
   * must re-read and run its gates against the fresh lines instead.
   */
  seedLinesIfEmpty(
    payoutTermsId: string,
    lines: PayoutTermsLineInput[],
  ): Promise<boolean>;
  listLines(payoutTermsId: string): Promise<PayoutTermsLineRecord[]>;
  /** Lookup a single line by id (or null). Used by `confirmPayoutLine`. */
  getLineById(lineId: string): Promise<PayoutTermsLineRecord | null>;
  /**
   * Update confirmation lifecycle fields on a single line. The line's
   * percent / floor / cap stay frozen — the editor's `replaceLines` path
   * is the only writer for those.
   *
   * Guarded compare-and-swap (mirrors `AgreementsRepo.updateStatus`): the
   * write only lands when the stored `confirmationStatus` is in
   * `expectedFrom`; otherwise it throws
   * `{ code: "conflict", message: "payout_line_confirmation_changed" }`.
   * This makes concurrent decisions on the same line serialize at write
   * time rather than relying on snapshot pre-checks.
   */
  updateLineConfirmation(
    input: UpdatePayoutLineConfirmationInput,
  ): Promise<PayoutTermsLineRecord>;
  pinFeePolicy(input: {
    payoutTermsId: string;
    feePolicyId: string;
  }): Promise<PayoutTermsRecord>;
  /**
   * Copy-on-write a PayoutTerms row. The source row stays intact (so events
   * that already FK it keep their economics) and a brand-new row is returned
   * with all scalar fields + lines duplicated. Callers re-point any owning
   * entity (Organization / Place / Human / Event) at the returned id.
   *
   * Overrides:
   * - `payoutScheduleOverride`: replace the payout schedule on the clone.
   * - `isDefault`: the clone's `isDefault` flag. Pass `true` when the clone is
   *   replacing an org/place/human default; `false` when the clone is
   *   event-owned.
   * - `resetConfirmations`: when `true`, every cloned line with
   *   `requiresConfirmation = true` is reset to `PENDING` with cleared
   *   `confirmedAt` / counter fields. Use this when the change is materially
   *   economic for payees (e.g. payout schedule change).
   * - `bumpVersion`: when `true`, the clone's `version` is `source.version + 1`
   *   so the chain of replacements is auditable. Default false (version = 1).
   * - `statusOverride`: replace the clone's status. Used when cloning an
   *   ACTIVE default into a negotiation draft that must start PENDING
   *   (e.g. booking-request acceptance).
   * - `resetFeeMode` (required): `true` writes `feeMode: null` on the clone
   *   (and drops a pin to an ABSORB policy). Every SNAPSHOT of an
   *   org/place/human default passes `true` — event creation, booking
   *   acceptance, and the default-to-default copy in `updatePayoutSchedule`.
   *   `false` keeps the source's mode and pin. Since ABSORB was removed
   *   (docs/decisions/absorb-removed.md) no row says ABSORB and pricing never
   *   reads the stored mode (`SALE_FEE_MODE`), so the flag no longer decides
   *   how a sale is priced.
   *
   * Returns `null` if the source row does not exist.
   */
  clone(input: {
    sourcePayoutTermsId: string;
    payoutScheduleOverride?: PayoutSchedule;
    isDefault: boolean;
    resetConfirmations?: boolean;
    bumpVersion?: boolean;
    statusOverride?: PayoutTermsStatus;
    resetFeeMode: boolean;
  }): Promise<PayoutTermsRecord | null>;
  /**
   * Flip `isDefault = false` on a row. Used in the copy-on-write flow to
   * "retire" the source row once a clone has taken its place as the new
   * default, so reverse lookups that filter by `isDefault: true` don't see
   * duplicates.
   */
  markNotDefault(payoutTermsId: string): Promise<void>;
}

export type {
  ActivatePayoutTermsInput,
  ArchivePayoutTermsInput,
  PayoutLineConfirmationStatus,
  PayoutTermsKind,
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
  PayoutTermsLineRounding,
  PayoutTermsRecord,
  PayoutTermsStatus,
  PayoutSchedule,
  CreatePayoutTermsDraftInput,
  UpdatePayoutTermsDraftInput,
  UpdatePayoutLineConfirmationInput,
  ProvisionDefaultPrimaryInput,
  ResaleSharePayer,
  ResaleShareType,
} from "@th/types/repos/payout-terms";
