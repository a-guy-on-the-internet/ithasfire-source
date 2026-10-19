import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";

import {
  buildRefundDebitIdempotencyKey,
  buildTransferReversalCreditIdempotencyKey,
  groupReversalsByPayee,
  realisedDisputeDebitCentsByPayee,
  retainedCreditByPayee,
  writeExternalAmountRefundDebitsForOrder,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "../write-refund-debits";
import { attributeCreditToItems } from "../../../settlements/create-credits-from-order";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const PAYEE_A = "payee-aaaa";
const PAYEE_B = "payee-bbbb";
const ITEM_1 = "item-1111";
const ITEM_2 = "item-2222";
const ITEM_3 = "item-3333";

const ORDER = { id: ORDER_ID, currency: "usd" };

function makeTx(
  fake: ReturnType<typeof createFakePayeeLedgerRepo>,
  splits: Array<{ payeeId: string; amountCents: number }> = [],
) {
  // The splits fake is REAL, not a stale cast (Step C review round 2): the
  // helper's partial-miss detection reads tx.splits.getForOrder inside a
  // best-effort try/catch, so a harness without `splits` silently takes the
  // catch branch in every test and the detection path is never exercised —
  // green suites would not be evidence it works.
  return {
    payeeLedger: fake.repo,
    splits: { getForOrder: async () => splits },
  } as unknown as Pick<TxRepos, "payeeLedger" | "splits">;
}

/** Plant a dispute entry the way the dispute lifecycle writes it. */
function plantDisputeEntry(
  fake: ReturnType<typeof createFakePayeeLedgerRepo>,
  row: {
    type: "DISPUTE_DEBIT" | "DISPUTE_RELEASE";
    payeeId: string;
    amountCents: number;
    idempotencyKey: string;
    relatedEntryId?: string | null;
  },
) {
  const entry = {
    id: `planted-${fake.entries.length + 1}`,
    idempotencyKey: row.idempotencyKey,
    payeeId: row.payeeId,
    type: row.type,
    amountCents: row.amountCents,
    currency: "usd",
    sourceKind: "dispute",
    sourceId: "dispute_1",
    orderId: ORDER_ID,
    settlementId: null,
    disputeId: "dispute_1",
    relatedEntryId: row.relatedEntryId ?? null,
    description: row.type,
    metadata: null,
    createdAt: new Date(),
  } as const;
  fake.entries.push(entry);
  return entry;
}

describe("dispute-aware credit arithmetic", () => {
  it("realisedDisputeDebitCentsByPayee counts principal only, nets a WON reversal, ignores hold-releases and the fee twin", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({ orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: 5_000 });
    const principal = plantDisputeEntry(fake, {
      type: "DISPUTE_DEBIT", payeeId: PAYEE_A, amountCents: 1_000,
      idempotencyKey: "dispute-debit:dispute_1:payee-aaaa:usd",
    });
    plantDisputeEntry(fake, {
      type: "DISPUTE_DEBIT", payeeId: PAYEE_A, amountCents: 1_500,
      idempotencyKey: "dispute-debit-fee:dispute_1:payee-aaaa:usd",
    });
    // Hold-release flavour (relates to a hold, not a debit): no effect.
    plantDisputeEntry(fake, {
      type: "DISPUTE_RELEASE", payeeId: PAYEE_A, amountCents: 5_000,
      idempotencyKey: "dispute-release:dispute_1:hold_x", relatedEntryId: "hold_x",
    });
    const entries = await fake.repo.listOrderEntries(ORDER_ID);
    expect(realisedDisputeDebitCentsByPayee(entries).get(PAYEE_A)).toBe(1_000);
    expect(retainedCreditByPayee(entries).get(PAYEE_A)).toBe(4_000);

    // WON-after-LOST reversal of the principal nets it back out; the fee
    // reversal twin is ignored like the fee itself.
    plantDisputeEntry(fake, {
      type: "DISPUTE_RELEASE", payeeId: PAYEE_A, amountCents: 1_000,
      idempotencyKey: "dispute-debit-reversal:dispute_1:payee-aaaa:usd",
      relatedEntryId: principal.id,
    });
    plantDisputeEntry(fake, {
      type: "DISPUTE_RELEASE", payeeId: PAYEE_A, amountCents: 1_500,
      idempotencyKey: "dispute-debit-reversal-fee:dispute_1:payee-aaaa:usd",
      relatedEntryId: "fee_id",
    });
    const after = await fake.repo.listOrderEntries(ORDER_ID);
    expect(realisedDisputeDebitCentsByPayee(after).get(PAYEE_A)).toBe(0);
    expect(retainedCreditByPayee(after).get(PAYEE_A)).toBe(5_000);
  });

  it("a full refund after a partial LOST dispute stops at the credit (item-attributed arm)", async () => {
    // Credit 5000, dispute lost for 1000 → REFUND must be 4000, not 5000:
    // credit + debit would claw 6000 on a 5000 grant.
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: 5_000,
      items: { [ITEM_1]: 5_000 },
    });
    plantDisputeEntry(fake, {
      type: "DISPUTE_DEBIT", payeeId: PAYEE_A, amountCents: 1_000,
      idempotencyKey: "dispute-debit:dispute_1:payee-aaaa:usd",
    });

    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_after_dispute",
      attemptedFullRefund: true,
      useCase: "test",
    });

    expect(results).toEqual([
      { payeeId: PAYEE_A, debitCents: 4_000, entryId: expect.any(String) },
    ]);
    const totalTaken = fake.entries
      .filter((e) => e.type === "REFUND_DEBIT" || e.idempotencyKey.startsWith("dispute-debit:"))
      .reduce((sum, e) => sum + e.amountCents, 0);
    expect(totalTaken).toBe(5_000);
  });

  it("an external-amount refund after a partial LOST dispute stops at the credit too", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: 5_000,
      items: { [ITEM_1]: 5_000 },
    });
    plantDisputeEntry(fake, {
      type: "DISPUTE_DEBIT", payeeId: PAYEE_A, amountCents: 1_000,
      idempotencyKey: "dispute-debit:dispute_1:payee-aaaa:usd",
    });

    const results = await writeExternalAmountRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundKey: "re_ext_after_dispute",
      cumulativeRefundedCents: 5_000,
      expectedBuyerTotalCents: 5_000,
      useCase: "test",
    });

    expect(results).toEqual([
      { payeeId: PAYEE_A, debitCents: 4_000, entryId: expect.any(String) },
    ]);
  });
});

describe("writeRefundDebitsForOrder", () => {
  it("full refund debits the FULL credit — including omitted zero-share items", async () => {
    const fake = createFakePayeeLedgerRepo();
    // 3 items but only 2 carry attribution: a zero-share item was omitted
    // from metadata at credit time (attributeCreditToItems drops 0-cent
    // shares). Σ items (9_999) < credit (10_000) on purpose.
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_000,
      items: { [ITEM_1]: 6_000, [ITEM_2]: 3_999 },
    });

    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1, ITEM_2, ITEM_3],
      refundKey: "re_full_1",
      attemptedFullRefund: true,
      useCase: "test",
    });

    expect(results).toEqual([
      {
        payeeId: PAYEE_A,
        debitCents: 10_000,
        entryId: expect.any(String),
      },
    ]);
    const debits = fake.entriesOfType("REFUND_DEBIT");
    expect(debits).toHaveLength(1);
    expect(debits[0]).toMatchObject({
      amountCents: 10_000,
      idempotencyKey: buildRefundDebitIdempotencyKey(
        ORDER_ID,
        PAYEE_A,
        "re_full_1",
      ),
      orderId: ORDER_ID,
      currency: "usd",
    });
  });

  it("partial refund debits Σ of the refunded items' contributions, to the cent", async () => {
    const fake = createFakePayeeLedgerRepo();
    // Rounding-shaped distribution: 10_001 across three items.
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_001,
      items: { [ITEM_1]: 3_334, [ITEM_2]: 3_334, [ITEM_3]: 3_333 },
    });

    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1, ITEM_3],
      refundKey: "re_part_1",
      attemptedFullRefund: false,
      useCase: "test",
    });

    expect(results).toEqual([
      { payeeId: PAYEE_A, debitCents: 6_667, entryId: expect.any(String) },
    ]);
  });

  it("debits each payee independently on a multi-payee order", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 7_000,
      items: { [ITEM_1]: 7_000 },
    });
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_B,
      amountCents: 3_000,
      items: { [ITEM_1]: 3_000 },
    });

    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_multi_1",
      attemptedFullRefund: true,
      useCase: "test",
    });

    expect(results).toHaveLength(2);
    expect(new Map(results.map((r) => [r.payeeId, r.debitCents]))).toEqual(
      new Map([
        [PAYEE_A, 7_000],
        [PAYEE_B, 3_000],
      ]),
    );
  });

  it("clamps the partial sum to credit − prior debits and reports the bite", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_000,
      items: { [ITEM_1]: 6_000, [ITEM_2]: 4_000 },
    });
    // A prior refund already clawed 6_000 under a DIFFERENT key.
    await fake.repo.refundDebit({
      idempotencyKey: buildRefundDebitIdempotencyKey(
        ORDER_ID,
        PAYEE_A,
        "re_prior",
      ),
      payeeId: PAYEE_A,
      amountCents: 6_000,
      currency: "usd",
      orderId: ORDER_ID,
      description: "prior refund",
      sourceKind: "order_refund",
      sourceId: "re_prior",
    });

    const reportError = vi.fn();
    // Attribution says 6_000 (ITEM_1) but only 4_000 remains — the clamp
    // bites, the clamped amount is written, and the drift is reported.
    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_clamp_1",
      attemptedFullRefund: false,
      useCase: "test",
      reportError,
    });

    expect(results).toEqual([
      { payeeId: PAYEE_A, debitCents: 4_000, entryId: expect.any(String) },
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "test",
          step: "refundDebit",
          reason: "refund_debit_clamped",
        }),
      }),
    );
  });

  it("replays the same refundKey to a no-op via the repo's key uniqueness", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_000,
      items: { [ITEM_1]: 10_000 },
    });

    const first = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_replay_1",
      attemptedFullRefund: true,
      useCase: "test",
    });
    const second = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_replay_1",
      attemptedFullRefund: true,
      useCase: "test",
    });

    // The replay recomputes the IDENTICAL amount (same-key prior debits are
    // excluded from the Σ) and the repo returns the existing row: one entry.
    expect(fake.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("a DIFFERENT refund key after a full refund debits nothing (Σ-prior-debits arithmetic)", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_000,
      items: { [ITEM_1]: 10_000 },
    });

    await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_internal",
      attemptedFullRefund: true,
      useCase: "test",
    });
    // e.g. the charge.refunded webhook reconciling the SAME money under the
    // Stripe refund id: nothing remains, so nothing is written.
    const second = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_stripe",
      attemptedFullRefund: true,
      useCase: "test",
    });

    expect(second).toEqual([]);
    expect(fake.entriesOfType("REFUND_DEBIT")).toHaveLength(1);
  });

  it("writes NOTHING and reports (without throwing) when the order has no credits", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    const logger = { error: vi.fn(), child: vi.fn() };

    const results = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_precutover",
      attemptedFullRefund: true,
      useCase: "refundFullOrder",
      logger: logger as never,
      reportError,
    });

    expect(results).toEqual([]);
    expect(fake.entries).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      "refund_debit_no_credits_for_order",
      expect.objectContaining({ orderId: ORDER_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          useCase: "refundFullOrder",
          step: "refundDebit",
          reason: "no_credits_for_order",
        },
      }),
    );
  });

  it("never lets a throwing reporter change behaviour", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn(() => {
      throw new Error("reporter exploded");
    });

    await expect(
      writeRefundDebitsForOrder(makeTx(fake), {
        order: ORDER,
        refundedItemIds: [ITEM_1],
        refundKey: "re_reporter",
        attemptedFullRefund: true,
        useCase: "test",
        reportError,
      }),
    ).resolves.toEqual([]);
  });
});

describe("writeTransferReversalCreditsForOrder", () => {
  it("writes a linked TRANSFER_REVERSAL_CREDIT per payee on success", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 10_000,
      items: { [ITEM_1]: 10_000 },
    });
    const debits = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_rev_1",
      attemptedFullRefund: true,
      useCase: "test",
    });

    const credits = await writeTransferReversalCreditsForOrder(makeTx(fake), {
      order: ORDER,
      refundKey: "re_rev_1",
      reversals: [
        {
          payeeId: PAYEE_A,
          reversedCents: 9_700,
          reversalIds: ["trr_1"],
          stripeTransferIds: ["tr_1"],
        },
      ],
      debits,
      useCase: "test",
    });

    expect(credits).toEqual([
      { payeeId: PAYEE_A, creditCents: 9_700, entryId: expect.any(String) },
    ]);
    const rows = fake.entriesOfType("TRANSFER_REVERSAL_CREDIT");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amountCents: 9_700,
      relatedEntryId: debits[0]!.entryId,
      idempotencyKey: buildTransferReversalCreditIdempotencyKey(
        ORDER_ID,
        PAYEE_A,
        "re_rev_1",
      ),
      sourceId: "trr_1",
    });
  });

  it("reports missing_credit_for_payee when one payee's credit write was lost", async () => {
    // Spec §9's "silently skipped write": order split across two payees,
    // only payee A's credit exists. The refund debits A and must REPORT B —
    // a silent partial debit is the failure mode the detection exists for.
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 6_000,
      items: { [ITEM_1]: 6_000 },
    });

    const debits = await writeRefundDebitsForOrder(
      makeTx(fake, [
        { payeeId: PAYEE_A, amountCents: 6_000 },
        { payeeId: PAYEE_B, amountCents: 4_000 }, // credit never written
      ]),
      {
        order: ORDER,
        refundedItemIds: [ITEM_1],
        refundKey: "re_partial_miss",
        attemptedFullRefund: true,
        useCase: "test",
        reportError,
      },
    );

    // A's debit still writes — detection never blocks the refund.
    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: 6_000, entryId: expect.any(String) },
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("missing_credit_for_payee"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "missing_credit_for_payee" }),
        extra: expect.objectContaining({ missingPayeeIds: [PAYEE_B] }),
      }),
    );
  });

  it("stays silent for splits-less orders (cash) — no false alarms", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 5_000,
      items: { [ITEM_1]: 5_000 },
    });

    await writeRefundDebitsForOrder(makeTx(fake, []), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_no_splits",
      attemptedFullRefund: true,
      useCase: "test",
      reportError,
    });

    expect(reportError).not.toHaveBeenCalled();
  });

  it("CLAMPS a buyer-side reversal to the payee-side debit and reports the residual as drift", async () => {
    // Step C review pin: reversedCents is buyer-side (buyerTotal + tax −
    // Stripe fee); the debit is the payee-side credit share. PASS_THROUGH
    // fee mode makes the buyer side strictly larger — unclamped, a fully
    // refunded + fully clawed-back order would leave the payee at a
    // POSITIVE balance the payable query pays out as real money.
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 9_500,
      items: { [ITEM_1]: 9_500 },
    });
    const debits = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_clamp",
      attemptedFullRefund: true,
      useCase: "test",
      reportError,
    });
    expect(debits[0]!.debitCents).toBe(9_500);

    const credits = await writeTransferReversalCreditsForOrder(makeTx(fake), {
      order: ORDER,
      refundKey: "re_clamp",
      reversals: [
        {
          payeeId: PAYEE_A,
          reversedCents: 10_450, // buyer-side: fees ride along
          reversalIds: ["trr_clamp"],
          stripeTransferIds: ["tr_clamp"],
        },
      ],
      debits,
      useCase: "test",
      reportError,
    });

    // Credit == debit exactly — the pair nets to zero, never positive.
    expect(credits).toEqual([
      { payeeId: PAYEE_A, creditCents: 9_500, entryId: expect.any(String) },
    ]);
    expect(
      fake.entriesOfType("TRANSFER_REVERSAL_CREDIT")[0]!.amountCents,
    ).toBe(9_500);
    // The 950¢ residual is reported, not minted.
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("reversal_exceeds_debit"),
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "reversal_exceeds_debit" }),
      }),
    );
  });

  it("skips and reports a reversal with no matching debit (no gifted money)", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();

    const credits = await writeTransferReversalCreditsForOrder(makeTx(fake), {
      order: ORDER,
      refundKey: "re_rev_2",
      reversals: [
        {
          payeeId: PAYEE_A,
          reversedCents: 5_000,
          reversalIds: ["trr_2"],
          stripeTransferIds: ["tr_2"],
        },
      ],
      debits: [],
      useCase: "test",
      reportError,
    });

    expect(credits).toEqual([]);
    expect(fake.entries).toHaveLength(0);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "reversal_without_debit" }),
      }),
    );
  });
});

describe("groupReversalsByPayee", () => {
  it("groups per payee via the settlement map and sums reversed cents", () => {
    const grouped = groupReversalsByPayee(
      [
        {
          orderItemId: ITEM_1,
          settlementId: "s1",
          stripeTransferId: "tr_1",
          reversalId: "trr_1",
          reversedCents: 4_000,
        },
        {
          orderItemId: ITEM_2,
          settlementId: "s1",
          stripeTransferId: "tr_1",
          reversalId: "trr_1",
          reversedCents: 2_500,
        },
        {
          orderItemId: ITEM_3,
          settlementId: "s2",
          stripeTransferId: "tr_2",
          reversalId: "trr_2",
          reversedCents: 1_000,
        },
      ],
      new Map([
        ["s1", PAYEE_A],
        ["s2", PAYEE_B],
      ]),
      { useCase: "test", orderId: ORDER_ID },
    );

    expect(grouped).toEqual([
      {
        payeeId: PAYEE_A,
        reversedCents: 6_500,
        reversalIds: ["trr_1"],
        stripeTransferIds: ["tr_1"],
      },
      {
        payeeId: PAYEE_B,
        reversedCents: 1_000,
        reversalIds: ["trr_2"],
        stripeTransferIds: ["tr_2"],
      },
    ]);
  });

  it("skips and reports a result whose settlement cannot be mapped", () => {
    const reportError = vi.fn();
    const grouped = groupReversalsByPayee(
      [
        {
          orderItemId: ITEM_1,
          settlementId: "s-unknown",
          stripeTransferId: "tr_x",
          reversalId: "trr_x",
          reversedCents: 4_000,
        },
      ],
      new Map(),
      { useCase: "test", orderId: ORDER_ID, reportError },
    );

    expect(grouped).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "unmapped_settlement" }),
      }),
    );
  });
});

describe("missing-credit detection failure is reported, never silenced", () => {
  // The partial-miss detector is the ONLY signal for a partially-lost
  // SETTLEMENT_CREDIT write (spec §9's "silently skipped write"). A bare
  // `catch {}` around its splits read defeated that alarm with no log and no
  // report. The swallow itself is correct (detection must never block a
  // refund); the silence was the defect.
  function makeTxWithBrokenSplits(
    fake: ReturnType<typeof createFakePayeeLedgerRepo>,
  ) {
    return {
      payeeLedger: fake.repo,
      splits: {
        getForOrder: async () => {
          throw new Error("splits read failed");
        },
      },
    } as unknown as Pick<TxRepos, "payeeLedger" | "splits">;
  }

  it("writeRefundDebitsForOrder: still debits, and drift-reports the detector failure", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    const logger = { error: vi.fn(), child: vi.fn() };
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 6_000,
      items: { [ITEM_1]: 6_000 },
    });

    const debits = await writeRefundDebitsForOrder(makeTxWithBrokenSplits(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_detect_fail",
      attemptedFullRefund: true,
      useCase: "test",
      logger: logger as never,
      reportError,
    });

    // The refund is never blocked by the detector.
    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: 6_000, entryId: expect.any(String) },
    ]);
    // … but its failure is visible: logged at error AND reported.
    expect(logger.error).toHaveBeenCalledWith(
      "refund_ledger_missing_credit_detection_failed",
      expect.objectContaining({
        orderId: ORDER_ID,
        refundKey: "re_detect_fail",
        error: "splits read failed",
      }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "refund_ledger_missing_credit_detection_failed",
      }),
      expect.objectContaining({
        tags: {
          useCase: "test",
          step: "refundDebit",
          reason: "missing_credit_detection_failed",
        },
        extra: expect.objectContaining({
          orderId: ORDER_ID,
          refundKey: "re_detect_fail",
          error: "splits read failed",
        }),
      }),
    );
  });

  it("writeExternalAmountRefundDebitsForOrder: still debits, and drift-reports the detector failure", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    const logger = { error: vi.fn(), child: vi.fn() };
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 5_000,
      items: { [ITEM_1]: 5_000 },
    });

    const results = await writeExternalAmountRefundDebitsForOrder(
      makeTxWithBrokenSplits(fake),
      {
        order: ORDER,
        refundKey: "re_ext_detect_fail",
        cumulativeRefundedCents: 5_000,
        expectedBuyerTotalCents: 5_000,
        useCase: "test",
        logger: logger as never,
        reportError,
      },
    );

    expect(results).toEqual([
      { payeeId: PAYEE_A, debitCents: 5_000, entryId: expect.any(String) },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      "refund_ledger_missing_credit_detection_failed",
      expect.objectContaining({
        orderId: ORDER_ID,
        refundKey: "re_ext_detect_fail",
        error: "splits read failed",
      }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "refund_ledger_missing_credit_detection_failed",
      }),
      expect.objectContaining({
        tags: {
          useCase: "test",
          step: "refundDebit",
          reason: "missing_credit_detection_failed",
        },
        extra: expect.objectContaining({ error: "splits read failed" }),
      }),
    );
  });

  it("a throwing reporter never changes behaviour when the detector fails", async () => {
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: 1_000,
      items: { [ITEM_1]: 1_000 },
    });

    const debits = await writeRefundDebitsForOrder(makeTxWithBrokenSplits(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_detect_fail_reporter_throws",
      attemptedFullRefund: true,
      useCase: "test",
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
    });

    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: 1_000, entryId: expect.any(String) },
    ]);
  });
});

// ── Fee modes and the platform fee (owner ruling 2026-09-15) ────────────────
//
// docs/decisions/absorb-refund-returns-platform-fee.md. The numbers are the
// ledger's OWN: `attributeCreditToItems` is what `createCreditsFromOrder`
// freezes into `metadata.items`, fed the credit `computeAgreementBasis` yields.
// These cases model UNMARKED orders (sold before the 2026-10-11 ruling), where
// that is `amountGrossCents − feesPlatformCents` in BOTH fee modes; a
// FULL_PRICE order is credited `amountGrossCents`. The mode decides who funded
// the fee at checkout, not the basis.
// Each case names the three nets — organiser, platform, buyer — that make the
// money conserve.
describe("fee modes: the debit is the CREDITED amount, so the platform fee comes back by construction", () => {
  const FACE = 1_000;
  const FEE = 33;
  /** What computeAgreementBasis credits the organiser, either mode. */
  const CREDIT = FACE - FEE;

  it("ABSORB item refund: debit 967 (credited), never 1000 (face) — organiser net 0, platform gives back the 33 it kept, buyer net −processor fee", async () => {
    const fake = createFakePayeeLedgerRepo();
    const items = attributeCreditToItems([{ id: ITEM_1, amountCents: FACE }], CREDIT);
    // The chain: the frozen attribution already carries the credited amount,
    // not the face — this is why the debit needs no fee-mode branch.
    expect(items).toEqual({ [ITEM_1]: CREDIT });
    await fake.seedCredit({ orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: CREDIT, items });
    const reportError = vi.fn();

    const debits = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_absorb_item",
      attemptedFullRefund: false,
      useCase: "test",
      reportError,
    });

    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: CREDIT, entryId: expect.any(String) },
    ]);
    expect(debits[0]!.debitCents).not.toBe(FACE);
    // 967 by ATTRIBUTION, not by the clamp catching a face-valued 1000: a
    // biting clamp would have drift-reported `refund_debit_clamped`.
    expect(reportError).not.toHaveBeenCalled();
    // Organiser: credited 967, docked 967 → holds nothing, owes nothing.
    // Platform: kept 33 at checkout, refunds the buyer 1000 while clawing
    // 967 → the 33 goes back. Buyer: refunded face; only the processor fee
    // (withheld upstream of this writer) is lost.
    const entries = await fake.repo.listOrderEntries(ORDER_ID);
    expect(retainedCreditByPayee(entries).get(PAYEE_A)).toBe(0);
  });

  it("PASS_THROUGH item refund: unchanged — debit is the credited 967, never the 1033 the buyer paid — organiser net 0, platform returns the buyer-paid 33 from its own take, buyer net −processor fee", async () => {
    // Same basis (`gross − feesPlatformCents`); the buyer-side 1033 never
    // reaches this writer — it is the platform's to refund, not the payee's.
    const BUYER_PAID = FACE + FEE;
    const fake = createFakePayeeLedgerRepo();
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: CREDIT,
      items: attributeCreditToItems([{ id: ITEM_1, amountCents: FACE }], CREDIT),
    });

    const reportError = vi.fn();
    const debits = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_pt_item",
      attemptedFullRefund: false,
      useCase: "test",
      reportError,
    });

    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: CREDIT, entryId: expect.any(String) },
    ]);
    expect(debits[0]!.debitCents).not.toBe(BUYER_PAID);
    expect(debits[0]!.debitCents).toBeLessThanOrEqual(CREDIT);
    // Attribution, not clamp (see the ABSORB case).
    expect(reportError).not.toHaveBeenCalled();
  });

  it("full refund of an ABSORB order: debit == credit to the cent (2 × 1000 face, fee 66, credit 1934) — organiser net 0, platform gives back all 66", async () => {
    const fake = createFakePayeeLedgerRepo();
    const credit = 2 * FACE - 2 * FEE;
    const items = attributeCreditToItems(
      [
        { id: ITEM_1, amountCents: FACE },
        { id: ITEM_2, amountCents: FACE },
      ],
      credit,
    );
    expect(items).toEqual({ [ITEM_1]: CREDIT, [ITEM_2]: CREDIT });
    await fake.seedCredit({ orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: credit, items });

    const debits = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1, ITEM_2],
      refundKey: "re_absorb_full",
      attemptedFullRefund: true,
      useCase: "test",
    });

    expect(debits).toEqual([
      { payeeId: PAYEE_A, debitCents: credit, entryId: expect.any(String) },
    ]);
    const entries = await fake.repo.listOrderEntries(ORDER_ID);
    expect(retainedCreditByPayee(entries).get(PAYEE_A)).toBe(0);
  });

  it("partial then full on an ABSORB order: Σ debits == credit, never more — a later attributed refund clamps to nothing and reports (organiser docked exactly what they were credited)", async () => {
    const fake = createFakePayeeLedgerRepo();
    const reportError = vi.fn();
    const credit = 2 * FACE - 2 * FEE;
    await fake.seedCredit({
      orderId: ORDER_ID,
      payeeId: PAYEE_A,
      amountCents: credit,
      items: attributeCreditToItems(
        [
          { id: ITEM_1, amountCents: FACE },
          { id: ITEM_2, amountCents: FACE },
        ],
        credit,
      ),
    });

    const partial = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_1],
      refundKey: "re_1",
      attemptedFullRefund: false,
      useCase: "test",
      reportError,
    });
    expect(partial[0]!.debitCents).toBe(CREDIT);

    const full = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_2],
      refundKey: "re_2",
      attemptedFullRefund: true,
      useCase: "test",
      reportError,
    });
    expect(full[0]!.debitCents).toBe(credit - CREDIT);
    expect(reportError).not.toHaveBeenCalled();

    // A third, attributed refund of an already-clawed item: the clamp bites
    // to zero, nothing is written, and the drift is loud.
    const again = await writeRefundDebitsForOrder(makeTx(fake), {
      order: ORDER,
      refundedItemIds: [ITEM_2],
      refundKey: "re_3",
      attemptedFullRefund: false,
      useCase: "test",
      reportError,
    });
    expect(again).toEqual([]);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ reason: "refund_debit_clamped" }),
      }),
    );

    const totalDebited = fake
      .entriesOfType("REFUND_DEBIT")
      .reduce((sum, e) => sum + e.amountCents, 0);
    expect(totalDebited).toBe(credit);
    const entries = await fake.repo.listOrderEntries(ORDER_ID);
    expect(retainedCreditByPayee(entries).get(PAYEE_A)).toBe(0);
  });

  it("mixed prices under the per-ticket cap: item debits are the attribution's shares and sum to the credit exactly (faces 1000/1000/2000, fees 33/33/50, credit 3884)", async () => {
    // The attribution spreads the credit pro-rata by FACE (971/971/1942),
    // not by each ticket's own fee (967/967/1950). Per item the debit is
    // therefore the CREDITED share, and per order Σ debits is the credit.
    const fake = createFakePayeeLedgerRepo();
    const credit = 4_000 - (33 + 33 + 50);
    const items = attributeCreditToItems(
      [
        { id: ITEM_1, amountCents: 1_000 },
        { id: ITEM_2, amountCents: 1_000 },
        { id: ITEM_3, amountCents: 2_000 },
      ],
      credit,
    );
    expect(items).toEqual({ [ITEM_1]: 971, [ITEM_2]: 971, [ITEM_3]: 1_942 });
    await fake.seedCredit({ orderId: ORDER_ID, payeeId: PAYEE_A, amountCents: credit, items });

    const debited: number[] = [];
    for (const [key, itemId] of [
      ["re_a", ITEM_1],
      ["re_b", ITEM_2],
      ["re_c", ITEM_3],
    ] as const) {
      const out = await writeRefundDebitsForOrder(makeTx(fake), {
        order: ORDER,
        refundedItemIds: [itemId],
        refundKey: key,
        attemptedFullRefund: itemId === ITEM_3,
        useCase: "test",
      });
      debited.push(out[0]!.debitCents);
    }

    expect(debited).toEqual([971, 971, 1_942]);
    expect(debited.reduce((a, b) => a + b, 0)).toBe(credit);
  });
});
