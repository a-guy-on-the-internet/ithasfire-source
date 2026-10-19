/**
 * Deal terms and the settlement sheet — repo DTOs (deal-terms-and-settlement
 * stage 1, P4b). The shapes map 1:1 onto the calculator's types in
 * `packages/core/src/lib/settlement/deal-terms.ts`; the extra fields here are
 * storage-only (line economics the per-order editors own, provenance).
 */

export type DealClauseAmountType = "FIXED" | "PERCENT" | "FIXED_AND_PERCENT";
export type DealBasisKind = "GROSS" | "NET_POOL";
export type DealClauseResolution = "SUM" | "GREATER_OF";
export type DealDeductionKind = "RENTAL" | "EXPENSE" | "HOUSE_NUT";
export type OffPlatformAmountKind = "DOOR_CASH" | "BAR_SHARE" | "OTHER";
export type SettlementSheetStatus = "DRAFT" | "SETTLED";

/**
 * Every `PayoutTermsLine` of a terms row — the per-order lines AND the clauses
 * settled directly. Only the deal read sees this; the per-order engine reads
 * `PayoutTermsRepo.listLines`, which returns PERCENT + GROSS rows only.
 */
export interface DealClauseRecord {
  id: string;
  payoutTermsId: string;
  payeeId: string;
  amountType: DealClauseAmountType;
  amountCents: number | null;
  /** Null only on a FIXED clause. */
  percent: number | null;
  basis: DealBasisKind;
  resolution: DealClauseResolution | null;
  displayLabel: string | null;
  // Per-order line economics and confirmation state, carried so a deal write
  // preserves them on the lines it keeps (the legacy editors own them).
  ticketTypeId: string | null;
  floorCents: number;
  capPercent: number | null;
  priority: number;
  rounding: "FLOOR" | "NEAREST";
  requiresConfirmation: boolean;
  confirmationStatus: "PENDING" | "CONFIRMED" | "COUNTERED" | "DECLINED" | null;
  confirmedAt: Date | null;
  counterPercentBps: number | null;
  counterNote: string | null;
}

export interface DealDeductionRecord {
  id: string;
  payoutTermsId: string;
  kind: DealDeductionKind;
  label: string;
  amountCents: number | null;
  percent: number | null;
  creditedPayeeId: string;
  estimated: boolean;
  /** Waterfall position, 0-based. Records come back in this order. */
  sortOrder: number;
}

export interface PayoutTermsDealRecord {
  payoutTermsId: string;
  /** Null on every pre-P4b row until a deal write stores one. */
  remainderPayeeId: string | null;
  /** Ordered priority asc, then id — the same order as `listLines`. */
  clauses: DealClauseRecord[];
  /** Ordered by sortOrder. */
  deductions: DealDeductionRecord[];
}

export type DealClauseWrite = Omit<DealClauseRecord, "payoutTermsId">;
export type DealDeductionWrite = Omit<
  DealDeductionRecord,
  "payoutTermsId" | "sortOrder"
>;

/**
 * Replace a terms row's WHOLE deal in one write: every line (per-order and
 * settled directly), every deduction (array order = waterfall order), and the
 * remainder holder.
 */
export interface ReplaceTermsDealInput {
  payoutTermsId: string;
  remainderPayeeId: string;
  clauses: DealClauseWrite[];
  deductions: DealDeductionWrite[];
}

/**
 * Something outside the terms row that points at it. A deal write uses the
 * full list to prove a row is used by exactly one owner before rewriting it
 * (one shared row would otherwise change another owner's money).
 */
export type PayoutTermsReferenceKind =
  | "AGREEMENT"
  | "EVENT_PRIMARY"
  | "EVENT_RESALE"
  | "EVENT_MERCH"
  | "ORG_DEFAULT_PRIMARY"
  | "ORG_DEFAULT_RESALE"
  | "HUMAN_DEFAULT_PRIMARY"
  | "HUMAN_DEFAULT_RESALE"
  | "PLACE_DEFAULT_PRIMARY"
  | "PLACE_DEFAULT_RESALE"
  | "SETTLEMENT";

/** A payee's answer to a clause settled directly (consent, EVENT terms). */
export interface AnswerDealClauseInput {
  payoutTermsId: string;
  clauseId: string;
  /**
   * The statuses the stored clause may be in for the write to land (a
   * guarded UPDATE). `null` stands for a clause with no status yet.
   */
  expectedFrom: ReadonlyArray<"PENDING" | null>;
  confirmationStatus: "CONFIRMED" | "DECLINED";
  confirmedAt: Date | null;
}

export interface PayoutTermsReference {
  kind: PayoutTermsReferenceKind;
  /** The referencing row's id (the event, org, place, settlement, …). */
  id: string;
}

// ── The settlement sheet ────────────────────────────────────────────────────

export interface SettlementSheetOffPlatformRecord {
  id: string;
  kind: OffPlatformAmountKind;
  label: string;
  /** Null = "Not entered" — never $0. */
  amountCents: number | null;
  heldByPayeeId: string;
  ownerPayeeId: string | null;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface SettlementSheetDeductionActualRecord {
  id: string;
  deductionId: string;
  amountCents: number;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface SettlementSheetDirectPaymentRecord {
  id: string;
  fromPayeeId: string;
  toPayeeId: string;
  amountCents: number;
  label: string;
  note: string | null;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface SettlementSheetRecord {
  id: string;
  eventId: string;
  status: SettlementSheetStatus;
  settledByHumanId: string | null;
  settledAt: Date | null;
  engineVersion: number | null;
  /** The frozen sheet (opaque JSON; core parses and re-checks it). */
  snapshot: unknown | null;
  revision: number;
  reopenedAt: Date | null;
  reopenedByHumanId: string | null;
  /** Ordered by createdAt, id. */
  offPlatform: SettlementSheetOffPlatformRecord[];
  deductionActuals: SettlementSheetDeductionActualRecord[];
  /** Ordered by createdAt, id. */
  directPayments: SettlementSheetDirectPaymentRecord[];
}

/**
 * Raw ledger facts behind the settlement sheet's ticket money and "paid
 * through Ithas Fire" (deal-terms.ts `paidThroughPlatform` sourcing rule).
 * Facts only — the arithmetic (each order's basis, basis net of refunds, paid
 * per payee, coverage) is core's.
 *
 * Every row of `orders` is one of the event's PRIMARY ticketing orders
 * (`kind = TICKETING`, `source = PRIMARY`); resale (other terms), comps and
 * memberships are outside it by construction. `credited` = the order carries
 * at least one SETTLEMENT_CREDIT, i.e. the per-order engine paid it out.
 * `perPayee` and `refundCount` are summed over the CREDITED orders only — the
 * order set the sheet's ticket money is summed over.
 */
export interface EventTicketLedgerRecord {
  orders: Array<{
    orderId: string;
    status: string;
    /** WEB | POS | CASH. A CASH sale is money taken at the door (W3). */
    paymentChannel: string;
    /**
     * Σ amountCents of this order's items marked refunded. Read for CASH
     * orders only (a part-refunded cash sale is counted net of it); 0 for
     * every other order.
     */
    refundedItemCents: number;
    amountGrossCents: number;
    feesPlatformCents: number;
    /**
     * The order's fee-policy snapshot as stored. `computeAgreementBasis`
     * reads `organiserCredit` from it to pick the order's own credit rule.
     */
    feePolicySnapshot: unknown;
    credited: boolean;
  }>;
  /** Every dispute on those orders (any order, credited or not). */
  disputes: Array<{ orderId: string; status: string; amountCents: number }>;
  /** Distinct (order, refund) pairs with a REFUND_DEBIT, credited orders only. */
  refundCount: number;
  /** Per payee over the credited orders: Σ SETTLEMENT_CREDIT and Σ REFUND_DEBIT. */
  perPayee: Array<{
    payeeId: string;
    creditCents: number;
    refundDebitCents: number;
  }>;
  /** Distinct currencies on those entries (a sheet sums one). */
  currencies: string[];
}

export interface UpsertSheetOffPlatformInput {
  sheetId: string;
  /** Present = update that row (it must belong to the sheet). */
  id?: string;
  kind: OffPlatformAmountKind;
  label: string;
  amountCents: number | null;
  heldByPayeeId: string;
  ownerPayeeId: string | null;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface UpsertSheetDeductionActualInput {
  sheetId: string;
  deductionId: string;
  amountCents: number;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface CreateSheetDirectPaymentInput {
  sheetId: string;
  fromPayeeId: string;
  toPayeeId: string;
  amountCents: number;
  label: string;
  note: string | null;
  enteredByHumanId: string;
  enteredAt: Date;
}

export interface MarkSheetSettledInput {
  sheetId: string;
  settledByHumanId: string;
  settledAt: Date;
  engineVersion: number;
  snapshot: unknown;
}

export interface ReopenSheetInput {
  sheetId: string;
  reopenedByHumanId: string;
  reopenedAt: Date;
}

// ── freeze-the-deal (docs/specs/2026-10-14/freeze-the-deal.spec.yaml) ──────

/**
 * One change made to a frozen event's deal (FR-005). `before` / `after` are
 * the core's normalised deal snapshot (`deals/_shared/deal-freeze.ts`,
 * `EventDealSnapshot`), stored as JSON; the core parses them back.
 */
export interface DealChangeRecord {
  id: string;
  eventId: string;
  /** Null once the human who made the change is deleted. */
  actorHumanId: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
}

export interface CreateDealChangeInput {
  eventId: string;
  actorHumanId: string;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

export interface ListDealChangesInput {
  eventId: string;
  limit: number;
  /** The last id of the previous page; absent = the newest. */
  cursor?: string | null;
}

export interface ListDealChangesResult {
  /** Newest first (createdAt desc, then id desc). */
  items: DealChangeRecord[];
  nextCursor: string | null;
}

export interface FreezeEventDealInput {
  eventId: string;
  frozenAt: Date;
  /** Null = frozen automatically (first publish, backfill). */
  frozenByHumanId: string | null;
}
