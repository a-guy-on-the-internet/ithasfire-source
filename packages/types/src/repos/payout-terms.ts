export type PayoutTermsStatus = "PENDING" | "ACTIVE" | "ARCHIVED";
export type PayoutTermsKind = "PRIMARY" | "RESALE" | "MERCH";
export type PayoutTermsLineRounding = "FLOOR" | "NEAREST";
/** How a resale share is stated (organiser-resale-share FR-001). */
export type ResaleShareType = "PERCENT" | "FLAT";
/** Who pays a resale share: SELLER from the ask, BUYER on top (FR-005). */
export type ResaleSharePayer = "SELLER" | "BUYER";
export type PayoutSchedule =
  | "ASAP"
  | "WEEK_OF_EVENT"
  | "ONE_WEEK_AFTER"
  | "TWO_WEEKS_AFTER"
  | "FOUR_WEEKS_AFTER";

export interface PayoutTermsRecord {
  id: string;
  kind: PayoutTermsKind;
  status: PayoutTermsStatus;
  feeMode: "ABSORB" | "PASS_THROUGH" | null;
  feePolicyId: string | null;
  isDefault: boolean;
  settlementCurrency: string;
  payoutSchedule: PayoutSchedule;
  resaleProcessingFeeConfigRef: string | null;
  resalePayoutReleaseDays: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  // ── P4b (deal terms) ──
  /**
   * Set once a deal has been written onto these terms (a deal write always
   * leaves the per-order lines at exactly 100%). Null on legacy rows.
   * Optional only so hand-built fakes predating P4b still type-check; the
   * Prisma adapter always sets it.
   */
  remainderPayeeId?: string | null;
  // ── Resale share clause (organiser-resale-share FR-001) ──
  // Optional only so hand-built fakes predating the clause still type-check;
  // the Prisma adapter always sets all four. Shape is held by the SQL CHECK
  // "PayoutTerms_resale_share_shape_check": null type = not set (bps and
  // cents null); PERCENT = bps 0..1000; FLAT = cents > 0.
  resaleShareType?: ResaleShareType | null;
  resaleShareBps?: number | null;
  resaleShareCents?: number | null;
  resaleSharePayer?: ResaleSharePayer;
}

export type PayoutLineConfirmationStatus =
  | "PENDING"
  | "CONFIRMED"
  | "COUNTERED"
  | "DECLINED";

export interface PayoutTermsLineRecord {
  id: string;
  payoutTermsId: string;
  payeeId: string;
  /** Optional ticket-type scoping. Null = applies to all ticket types. */
  ticketTypeId: string | null;
  percent: number;
  floorCents: number;
  capPercent: number | null;
  priority: number;
  rounding: PayoutTermsLineRounding;
  /** Auto-stamped on owner-line creation; non-owner lines start as true. */
  requiresConfirmation: boolean;
  /** Lifecycle when requiresConfirmation = true; null otherwise. */
  confirmationStatus: PayoutLineConfirmationStatus | null;
  confirmedAt: Date | null;
  /**
   * The payee's COUNTER ask, in basis points; set while
   * confirmationStatus = COUNTERED. An ask only — it never changes
   * `percent`; a party applies it via the DRAFT line editor. Cleared on
   * confirm/decline and whenever the line's economics are edited.
   */
  counterPercentBps: number | null;
  /** Required note (≥10 chars) accompanying a COUNTER; shared with the parties. */
  counterNote: string | null;
  // ── P4b (deal terms) ──
  /**
   * Always "PERCENT" / "GROSS" on a record from `listLines` and friends: the
   * adapter returns only the lines the per-order engine may pay (FR-005).
   * Carried so `computeOrderSplits` can refuse anything else as a second
   * fence. Optional only so hand-built fakes predating P4b still type-check;
   * the Prisma adapter always sets both.
   */
  amountType?: "PERCENT";
  basis?: "GROSS";
}

export interface UpdatePayoutLineConfirmationInput {
  lineId: string;
  /**
   * Write-time CAS guard: the confirmation statuses the stored row may
   * currently hold for the write to land. `null` means "legacy row with no
   * status yet" (the confirm use case treats null as PENDING). When the
   * stored status is not in this list the adapter throws
   * `{ code: "conflict", message: "payout_line_confirmation_changed" }`.
   */
  expectedFrom: readonly (PayoutLineConfirmationStatus | null)[];
  confirmationStatus: PayoutLineConfirmationStatus;
  confirmedAt: Date | null;
  counterPercentBps?: number | null;
  counterNote?: string | null;
}

export interface PayoutTermsLineInput {
  id?: string;
  payeeId: string;
  ticketTypeId?: string | null;
  percent: number;
  floorCents: number;
  capPercent?: number | null;
  priority: number;
  rounding: PayoutTermsLineRounding;
  /** Defaults to false (owner line) when omitted. */
  requiresConfirmation?: boolean;
  /** Set explicitly by callers that want to preserve confirmation state. */
  confirmationStatus?: PayoutLineConfirmationStatus | null;
  confirmedAt?: Date | null;
  counterPercentBps?: number | null;
  counterNote?: string | null;
}

// No `feeMode` on either draft input: the per-event Fee Handling switch was
// dropped (docs/decisions/fee-mode-switch-dropped.md). New terms leave the
// column null. ABSORB is removed (docs/decisions/absorb-removed.md): existing
// rows were migrated, and pricing never reads this column (`SALE_FEE_MODE`).
export interface CreatePayoutTermsDraftInput {
  kind: PayoutTermsKind;
  settlementCurrency: string;
  feePolicyId?: string | null;
  /**
   * Seed the draft's payout schedule (e.g. inherited from the owning
   * entity's default PRIMARY terms). When omitted, the schema default
   * (TWO_WEEKS_AFTER) applies.
   */
  payoutSchedule?: PayoutSchedule;
  resaleProcessingFeeConfigRef?: string | null;
  resalePayoutReleaseDays?: number;
  /** Resale share clause (FR-001). Omitted = not set (create) / unchanged (update). */
  resaleShareType?: ResaleShareType | null;
  resaleShareBps?: number | null;
  resaleShareCents?: number | null;
  resaleSharePayer?: ResaleSharePayer;
}

/**
 * Guarded compare-and-swap activation. The transition to ACTIVE only lands
 * when the stored `status` is in `expectedFrom`; a 0-match returns `null`
 * (instead of throwing) so callers decide whether the miss is benign — the
 * row was concurrently activated — or fatal (archived/deleted).
 */
export interface ActivatePayoutTermsInput {
  payoutTermsId: string;
  /** Statuses the stored row may currently hold for the write to land. */
  expectedFrom: readonly PayoutTermsStatus[];
}

/** See `PayoutTermsRepo.archive` (booking-the-night FR-009). */
export interface ArchivePayoutTermsInput {
  payoutTermsId: string;
  /** Statuses the stored row may currently hold for the write to land. */
  expectedFrom: readonly PayoutTermsStatus[];
}

export interface UpdatePayoutTermsDraftInput {
  payoutTermsId: string;
  settlementCurrency?: string;
  feePolicyId?: string | null;
  resaleProcessingFeeConfigRef?: string | null;
  resalePayoutReleaseDays?: number;
  /** Resale share clause (FR-001). Omitted = not set (create) / unchanged (update). */
  resaleShareType?: ResaleShareType | null;
  resaleShareBps?: number | null;
  resaleShareCents?: number | null;
  resaleSharePayer?: ResaleSharePayer;
  /**
   * When true, `version` goes up by one in the same UPDATE. A ticket records
   * its resale clause keyed by terms id + version (organiser-resale-share
   * FR-003), so an in-place change of the clause must bump it; the writer
   * decides whether its change is one.
   */
  bumpVersion?: boolean;
}

/**
 * Atomically create an ACTIVE PRIMARY PayoutTerms row plus its single
 * owner line in one write. Unlike `createDraft` (which produces a PENDING
 * row that the upsert/confirmation machinery later activates), this is the
 * one-shot path used to auto-provision an organizer's default agreement at
 * publish time — a single 100% line to the owner's own Payee. It mirrors the
 * shape the seed script writes directly, but goes through the repo so use
 * cases never reach for Prisma.
 */
export interface ProvisionDefaultPrimaryInput {
  /** Payee that receives 100% of the seller's post-fee net. */
  payeeId: string;
  /** Settlement currency (lowercased 3-letter code), e.g. "usd". */
  settlementCurrency: string;
  /**
   * When true, the new row is marked `isDefault` so reverse lookups that
   * filter by `isDefault: true` (the org/human Payments settings list) see it.
   */
  isDefault: boolean;
  /**
   * Payout schedule for the new row (e.g. the requested schedule when the
   * entity default is provisioned on demand from the payout settings page,
   * or the entity default's schedule when an event-owned row inherits it).
   * When omitted, the schema default (TWO_WEEKS_AFTER) applies.
   */
  payoutSchedule?: PayoutSchedule;
}
