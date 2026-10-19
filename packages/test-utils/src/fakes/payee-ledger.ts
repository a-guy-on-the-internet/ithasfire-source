import type {
  CashSaleDebitPayeeLedgerInput,
  CashSaleDebitReversalPayeeLedgerInput,
  PayeeLedgerEntryRecord,
  PayeeLedgerRepo,
  RefundDebitPayeeLedgerInput,
  SettlementCreditPayeeLedgerInput,
  TransferReversalCreditPayeeLedgerInput,
} from "@th/ports/repos/payee-ledger";

/**
 * In-memory fake of the payee-ledger repo surface the REFUND paths touch
 * (`listOrderEntries` / `refundDebit` / `transferReversalCredit`, plus
 * `settlementCredit` for seeding) and the door cash paths touch
 * (`cashSaleDebit` / `cashSaleDebitReversal` / `findCashSaleDebit`). Honors
 * the real adapter's contracts:
 *
 *  - `idempotencyKey` is UNIQUE — a replay returns the existing row without
 *    creating a second entry (so tests can assert "same refundKey twice →
 *    one debit" against real replay mechanics, not a mock's amnesia);
 *  - amounts ≤ 0 throw, exactly like the adapter's guards.
 *
 * Every other repo method throws on use — a test that reaches one is
 * exercising surface this fake does not model, and should say so loudly.
 */
export interface FakePayeeLedger {
  repo: PayeeLedgerRepo;
  entries: PayeeLedgerEntryRecord[];
  /** Seed a SETTLEMENT_CREDIT (thin wrapper over `repo.settlementCredit`). */
  seedCredit(input: {
    orderId: string;
    payeeId: string;
    amountCents: number;
    items?: Record<string, number>;
    currency?: string;
    idempotencyKey?: string;
  }): Promise<PayeeLedgerEntryRecord>;
  entriesOfType(type: PayeeLedgerEntryRecord["type"]): PayeeLedgerEntryRecord[];
}

export function createFakePayeeLedgerRepo(): FakePayeeLedger {
  const entries: PayeeLedgerEntryRecord[] = [];
  const byKey = new Map<string, PayeeLedgerEntryRecord>();
  let nextId = 1;

  function insert(
    row: Omit<PayeeLedgerEntryRecord, "id" | "createdAt">,
  ): PayeeLedgerEntryRecord {
    const existing = byKey.get(row.idempotencyKey);
    if (existing) return existing;
    const entry: PayeeLedgerEntryRecord = {
      ...row,
      id: `ledger-${nextId++}`,
      createdAt: new Date(),
    };
    entries.push(entry);
    byKey.set(entry.idempotencyKey, entry);
    return entry;
  }

  const notImplemented = (method: string) => () => {
    throw new Error(`fake_payee_ledger_method_not_implemented: ${method}`);
  };

  const repo = {
    listOrderEntries: async (orderId: string) =>
      entries.filter(
        (e) =>
          e.orderId === orderId &&
          (e.type === "SETTLEMENT_CREDIT" ||
            e.type === "REFUND_DEBIT" ||
            e.type === "TRANSFER_REVERSAL_CREDIT" ||
            e.type === "DISPUTE_DEBIT" ||
            e.type === "DISPUTE_RELEASE"),
      ),

    settlementCredit: async (input: SettlementCreditPayeeLedgerInput) => {
      if (input.amountCents <= 0) {
        throw new Error("payee_ledger_settlement_credit_amount_must_be_positive");
      }
      return insert({
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "SETTLEMENT_CREDIT",
        amountCents: input.amountCents,
        currency: input.currency.trim().toLowerCase(),
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        orderId: input.orderId,
        settlementId: null,
        disputeId: null,
        relatedEntryId: null,
        availableAt: input.availableAt,
        consumedByEntryId: null,
        description: input.description,
        metadata: input.metadata ?? null,
      });
    },

    refundDebit: async (input: RefundDebitPayeeLedgerInput) => {
      if (input.amountCents <= 0) {
        throw new Error("payee_ledger_refund_debit_amount_must_be_positive");
      }
      return insert({
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "REFUND_DEBIT",
        amountCents: input.amountCents,
        currency: input.currency.trim().toLowerCase(),
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        orderId: input.orderId,
        settlementId: null,
        disputeId: null,
        relatedEntryId: null,
        availableAt: null,
        consumedByEntryId: null,
        description: input.description,
        metadata: input.metadata ?? null,
      });
    },

    transferReversalCredit: async (
      input: TransferReversalCreditPayeeLedgerInput,
    ) => {
      if (input.amountCents <= 0) {
        throw new Error(
          "payee_ledger_transfer_reversal_credit_amount_must_be_positive",
        );
      }
      return insert({
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "TRANSFER_REVERSAL_CREDIT",
        amountCents: input.amountCents,
        currency: input.currency.trim().toLowerCase(),
        sourceKind: input.sourceKind ?? "transfer_reversal",
        sourceId: input.sourceId ?? input.relatedEntryId,
        orderId: input.orderId,
        settlementId: null,
        disputeId: null,
        relatedEntryId: input.relatedEntryId,
        availableAt: null,
        consumedByEntryId: null,
        description: input.description,
        metadata: input.metadata ?? null,
      });
    },

    cashSaleDebit: async (input: CashSaleDebitPayeeLedgerInput) => {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        throw new Error("payee_ledger_cash_sale_debit_amount_must_be_positive");
      }
      return insert({
        idempotencyKey: input.idempotencyKey,
        payeeId: input.payeeId,
        type: "CASH_SALE_DEBIT",
        amountCents: input.amountCents,
        currency: input.currency.trim().toLowerCase(),
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        orderId: input.orderId,
        settlementId: null,
        disputeId: null,
        relatedEntryId: null,
        availableAt: null,
        consumedByEntryId: null,
        description: input.description,
        metadata: input.metadata ?? null,
      });
    },

    // Same contract as the adapter: amount/payee/currency/order are COPIED
    // from the debit row; null when there is no debit; a debit reverses at
    // most once, under any key.
    cashSaleDebitReversal: async (
      input: CashSaleDebitReversalPayeeLedgerInput,
    ) => {
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return existing;
      const debit = byKey.get(input.debitIdempotencyKey);
      if (!debit) return null;
      if (debit.type !== "CASH_SALE_DEBIT") {
        throw new Error(
          "payee_ledger_cash_sale_debit_reversal_target_not_a_debit",
        );
      }
      const prior = entries.find(
        (e) =>
          e.type === "CASH_SALE_DEBIT_REVERSAL" && e.relatedEntryId === debit.id,
      );
      if (prior) return prior;
      return insert({
        idempotencyKey: input.idempotencyKey,
        payeeId: debit.payeeId,
        type: "CASH_SALE_DEBIT_REVERSAL",
        amountCents: debit.amountCents,
        currency: debit.currency,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        orderId: debit.orderId,
        settlementId: null,
        disputeId: null,
        relatedEntryId: debit.id,
        availableAt: null,
        consumedByEntryId: null,
        description: input.description,
        metadata: input.metadata ?? null,
      });
    },

    // Same contract as the adapter: the row under the key, reversed or not;
    // null when absent; a non-debit under the key is a collision.
    findCashSaleDebit: async (debitIdempotencyKey: string) => {
      const debit = byKey.get(debitIdempotencyKey);
      if (!debit) return null;
      if (debit.type !== "CASH_SALE_DEBIT") {
        throw new Error("payee_ledger_cash_sale_debit_key_not_a_debit");
      }
      return debit;
    },

    hold: notImplemented("hold"),
    debit: notImplemented("debit"),
    reverseDisputeDebit: notImplemented("reverseDisputeDebit"),
    reserveHold: notImplemented("reserveHold"),
    reserveRelease: notImplemented("reserveRelease"),
    listUnreleasedReserveHolds: notImplemented("listUnreleasedReserveHolds"),
    sumReserveReleasedByPayoutItem: notImplemented(
      "sumReserveReleasedByPayoutItem",
    ),
    listDebitsForDispute: notImplemented("listDebitsForDispute"),
    listActiveHoldsByDispute: notImplemented("listActiveHoldsByDispute"),
    releaseHold: notImplemented("releaseHold"),
    releaseHoldsForDispute: notImplemented("releaseHoldsForDispute"),
    getBalance: notImplemented("getBalance"),
    listEntries: notImplemented("listEntries"),
    payoutDebit: notImplemented("payoutDebit"),
    listOrderEntriesForOrders: notImplemented("listOrderEntriesForOrders"),
    listPayableBalances: notImplemented("listPayableBalances"),
    // The three aggregate/forecast reads. Named here rather than left off the
    // object: an absent key is `undefined`, and a test that reaches one gets
    // "is not a function" instead of this fake's own named error — which is
    // the difference between "this fake does not model that" and half an hour
    // of debugging. They are also the reads that REFUSE a TransactionClient,
    // so a caller must reach them on the TOP-LEVEL repos; a test harness that
    // builds its repos as `{ tx } as Repos` never reaches them at all and
    // will pass over dead code.
    listUpcomingMaturities: notImplemented("listUpcomingMaturities"),
    sumOutstandingLiability: notImplemented("sumOutstandingLiability"),
    listConsumableCredits: notImplemented("listConsumableCredits"),
    markCreditsConsumed: notImplemented("markCreditsConsumed"),
    listRollupDrift: notImplemented("listRollupDrift"),
    listConservationViolations: notImplemented("listConservationViolations"),
    listCompletenessGaps: notImplemented("listCompletenessGaps"),
    listUnreversedCashSaleDebitsOnCancelledEvents: notImplemented(
      "listUnreversedCashSaleDebitsOnCancelledEvents",
    ),
    listDebtPositions: notImplemented("listDebtPositions"),
    listUnrecoveredCashDebts: notImplemented("listUnrecoveredCashDebts"),
  } as unknown as PayeeLedgerRepo;

  return {
    repo,
    entries,
    seedCredit: ({ orderId, payeeId, amountCents, items, currency, idempotencyKey }) =>
      repo.settlementCredit({
        idempotencyKey:
          idempotencyKey ?? `settlement-credit:${orderId}:${payeeId}`,
        payeeId,
        amountCents,
        currency: currency ?? "usd",
        orderId,
        availableAt: new Date("2030-01-01T00:00:00.000Z"),
        description: `Ticket revenue — order ${orderId}`,
        metadata: { items: items ?? {} },
        sourceKind: "order_split",
        sourceId: orderId,
      }),
    entriesOfType: (type) => entries.filter((e) => e.type === type),
  };
}
