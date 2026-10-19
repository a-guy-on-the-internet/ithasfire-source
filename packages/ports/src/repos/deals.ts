import type {
  AnswerDealClauseInput,
  CreateDealChangeInput,
  CreateSheetDirectPaymentInput,
  DealBasisKind,
  DealClauseAmountType,
  DealClauseRecord,
  DealClauseResolution,
  DealClauseWrite,
  DealDeductionKind,
  DealDeductionRecord,
  DealDeductionWrite,
  DealChangeRecord,
  EventTicketLedgerRecord,
  FreezeEventDealInput,
  ListDealChangesInput,
  ListDealChangesResult,
  MarkSheetSettledInput,
  OffPlatformAmountKind,
  PayoutTermsDealRecord,
  PayoutTermsReference,
  PayoutTermsReferenceKind,
  ReopenSheetInput,
  ReplaceTermsDealInput,
  SettlementSheetDeductionActualRecord,
  SettlementSheetDirectPaymentRecord,
  SettlementSheetOffPlatformRecord,
  SettlementSheetRecord,
  SettlementSheetStatus,
  UpsertSheetDeductionActualInput,
  UpsertSheetOffPlatformInput,
} from "@th/types/repos/deals";

/**
 * Deal terms storage and the per-event settlement sheet (deal-terms-and-
 * settlement stage 1, P4b). Nothing here moves money.
 *
 * TERMS: `getTermsDeal` / `replaceTermsDeal` see EVERY line of a terms row.
 * They are the only reads of non-payout clauses; the per-order engine keeps
 * reading `PayoutTermsRepo.listLines`, which is fenced to PERCENT + GROSS.
 *
 * SHEET WRITES ARE SERIALIZED ON THE SHEET ROW. Every write first calls
 * {@link DealsRepo.lockDraftSheet} inside the caller's transaction: a guarded
 * `UPDATE … WHERE status = 'DRAFT'` that bumps `revision`. The row lock it
 * takes is held to commit, so a write and "Mark settled" can never interleave
 * — and a write that queues behind a committed "Mark settled" re-checks the
 * status and is refused.
 */
export interface DealsRepo {
  /**
   * Lock the terms row for the caller's transaction (a guarded UPDATE, held
   * to commit). A deal write takes it BEFORE reading the deal it replaces,
   * so two writes — a double-click included — run one after the other and
   * the second replaces the first instead of adding to it. False when the
   * terms row does not exist.
   */
  lockTerms(payoutTermsId: string): Promise<boolean>;
  /** Null when the terms row does not exist. */
  getTermsDeal(payoutTermsId: string): Promise<PayoutTermsDealRecord | null>;
  /**
   * Replace every line and deduction of a terms row and set its remainder
   * holder. Call inside `repos.tx()`.
   */
  replaceTermsDeal(input: ReplaceTermsDealInput): Promise<void>;
  /**
   * Every row that points at the terms row: agreements, events (primary,
   * resale, merch), org / human / place defaults (primary and resale) and
   * settlements. Capped per kind (a couple of ids each) — callers ask "is
   * this the only reference?", not "how many?".
   */
  listTermsReferences(payoutTermsId: string): Promise<PayoutTermsReference[]>;
  /**
   * Point an event's PRIMARY terms at `payoutTermsId` only while it has none
   * (`Event.payoutTermsId IS NULL`), a guarded UPDATE. False when the event
   * already has terms (a concurrent writer linked first) or does not exist.
   */
  linkEventPrimaryTermsIfUnset(input: {
    eventId: string;
    payoutTermsId: string;
  }): Promise<boolean>;
  /**
   * Point an org's default RESALE terms at `payoutTermsId` only while it has
   * none (`Organization.defaultResalePayoutTermsId IS NULL`), a guarded
   * UPDATE. False when the org already has one (a concurrent minter linked
   * first) or does not exist. organiser-resale-share B5a.
   */
  linkOrgDefaultResaleTermsIfUnset(input: {
    orgId: string;
    payoutTermsId: string;
  }): Promise<boolean>;
  /**
   * Record a payee's answer on ONE clause settled directly (not a per-order
   * PERCENT/GROSS line: those answer through `PayoutTermsRepo`), guarded:
   * lands only when the clause is on `payoutTermsId`, requires confirmation,
   * and its status is in `expectedFrom`. False otherwise — the caller
   * reports a conflict.
   */
  answerDealClause(input: AnswerDealClauseInput): Promise<boolean>;

  /** The event's sheet with its rows, or null when nothing was typed yet. */
  getSheetByEventId(eventId: string): Promise<SettlementSheetRecord | null>;
  /** Create the event's DRAFT sheet if it has none; return its id. Idempotent. */
  ensureSheet(eventId: string): Promise<{ id: string }>;
  /**
   * Lock the sheet row for this transaction and bump its revision — only
   * when it is DRAFT. Returns false when the sheet is SETTLED (or gone).
   */
  lockDraftSheet(sheetId: string): Promise<boolean>;
  /**
   * Lock the sheet row for this transaction and bump its revision — only
   * when it is SETTLED (the reopen path). Returns false otherwise.
   */
  lockSettledSheet(sheetId: string): Promise<boolean>;

  /** Insert, or update the row `input.id` (null when it is not on this sheet). */
  upsertOffPlatform(
    input: UpsertSheetOffPlatformInput,
  ): Promise<SettlementSheetOffPlatformRecord | null>;
  /** False when the row is not on this sheet. */
  deleteOffPlatform(sheetId: string, rowId: string): Promise<boolean>;
  upsertDeductionActual(
    input: UpsertSheetDeductionActualInput,
  ): Promise<SettlementSheetDeductionActualRecord>;
  /** False when the sheet has no actual for that deduction. */
  deleteDeductionActual(sheetId: string, deductionId: string): Promise<boolean>;
  createDirectPayment(
    input: CreateSheetDirectPaymentInput,
  ): Promise<SettlementSheetDirectPaymentRecord>;
  /** False when the payment is not on this sheet. */
  deleteDirectPayment(sheetId: string, paymentId: string): Promise<boolean>;

  /** DRAFT → SETTLED, guarded. False when it was not DRAFT. */
  markSheetSettled(input: MarkSheetSettledInput): Promise<boolean>;
  /** SETTLED → DRAFT, guarded; clears the frozen copy. False when not SETTLED. */
  reopenSheet(input: ReopenSheetInput): Promise<boolean>;

  /**
   * The ledger sums behind the sheet's ticket money and "paid through Ithas
   * Fire". See {@link EventTicketLedgerRecord} for the exact order set.
   */
  readEventTicketLedger(eventId: string): Promise<EventTicketLedgerRecord>;

  // ── freeze-the-deal (FR-001, FR-005, FR-007) ──
  // The freeze is READ through `EventsRepo.getById` (`dealFrozenAt`), under
  // the terms row lock, by every deal write (`deals/_shared/deal-freeze.ts`).
  /**
   * Freeze the event's deal only while it is not frozen
   * (`Event.dealFrozenAt IS NULL`), a guarded UPDATE: an existing freeze is
   * never overwritten. False when already frozen or the event does not exist.
   */
  freezeEventDealIfUnfrozen(input: FreezeEventDealInput): Promise<boolean>;
  /** Append one change record. Call inside the deal write's transaction. */
  createDealChange(input: CreateDealChangeInput): Promise<DealChangeRecord>;
  /** One page of the event's changes, newest first. */
  listDealChanges(input: ListDealChangesInput): Promise<ListDealChangesResult>;
  /**
   * The before / after of EVERY change on the event (no page): who appears
   * in them decides who may read the history (a payee a change removed
   * included). Bounded by the event's own changes.
   */
  listDealChangeSnapshots(
    eventId: string,
  ): Promise<Array<Pick<DealChangeRecord, "before" | "after">>>;
}

export type {
  AnswerDealClauseInput,
  CreateDealChangeInput,
  CreateSheetDirectPaymentInput,
  DealBasisKind,
  DealClauseAmountType,
  DealClauseRecord,
  DealClauseResolution,
  DealClauseWrite,
  DealDeductionKind,
  DealDeductionRecord,
  DealDeductionWrite,
  DealChangeRecord,
  EventTicketLedgerRecord,
  FreezeEventDealInput,
  ListDealChangesInput,
  ListDealChangesResult,
  MarkSheetSettledInput,
  OffPlatformAmountKind,
  PayoutTermsDealRecord,
  PayoutTermsReference,
  PayoutTermsReferenceKind,
  ReopenSheetInput,
  ReplaceTermsDealInput,
  SettlementSheetDeductionActualRecord,
  SettlementSheetDirectPaymentRecord,
  SettlementSheetOffPlatformRecord,
  SettlementSheetRecord,
  SettlementSheetStatus,
  UpsertSheetDeductionActualInput,
  UpsertSheetOffPlatformInput,
};
