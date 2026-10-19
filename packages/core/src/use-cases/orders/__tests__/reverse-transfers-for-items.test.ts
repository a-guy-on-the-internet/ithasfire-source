import { describe, expect, it, vi } from "vitest";

import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { reverseTransfersForItems } from "../reverse-transfers-for-items";

const ITEM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORDER_ID = "22222222-2222-4222-8222-222222222222";

function makeLedgerPayoutItem(
  overrides: Partial<{
    payoutItemId: string;
    stripeTransferId: string;
    payeeId: string;
    plannedOrderItemIds: string[];
    amountCents: number;
    netAmountCents: number;
  }> = {},
) {
  return {
    payoutItemId: "pitem-1",
    stripeTransferId: "tr_ledger_1",
    payeeId: "payee-1",
    currency: "usd",
    plannedOrderItemIds: [ITEM_A, ITEM_B],
    amountCents: 10_000,
    netAmountCents: 10_000,
    ...overrides,
  };
}

function makeContext(opts?: {
  payoutItems?: ReturnType<typeof makeLedgerPayoutItem>[];
  orderEntries?: Array<{
    type: string;
    payeeId: string;
    items: Record<string, number>;
  }>;
  /**
   * Initial Stripe-side transfer state, keyed by transfer id (copied into
   * mutable per-context state — `reverseTransfer` updates it cumulatively).
   * Unregistered ids report unbounded capacity (nothing reversed yet), so
   * the pre-flight never clamps under tests that don't model it.
   */
  transfers?: Map<
    string,
    { amountCents: number; amountReversedCents: number }
  >;
}) {
  const repos = {
    payoutItems: {
      listTransferredByPlannedOrderItemIds: vi.fn(
        async () => opts?.payoutItems ?? [],
      ),
    },
    orderItemSettlementLines: {
      listByOrderItemIds: vi.fn(async () => []),
    },
    settlementLines: { getByIds: vi.fn(async () => []) },
    settlements: { getByIds: vi.fn(async () => []) },
    orderItems: {
      getById: vi.fn(async (id: string) => ({ id, orderId: ORDER_ID })),
    },
    payeeLedger: {
      listOrderEntries: vi.fn(async () =>
        (opts?.orderEntries ?? []).map((e, i) => ({
          id: `entry-${i}`,
          type: e.type,
          payeeId: e.payeeId,
          amountCents: Object.values(e.items).reduce((a, b) => a + b, 0),
          orderId: ORDER_ID,
          metadata: { items: e.items },
        })),
      ),
    },
  } as unknown as Repos;

  // ── STATEFUL Stripe-mirroring payment fake ────────────────────────────
  // Mirrors the three live behaviours the recovery logic depends on:
  //  1. reversals accumulate on the transfer (`amount_reversed`) and a
  //     cumulative total beyond a registered transfer's amount REJECTS;
  //  2. same idempotency key + same amount → REPLAYS the original reversal
  //     (no state change); same key + DIFFERENT amount → idempotency error
  //     (same key, different params) — the exact failure a clamped retry
  //     re-request would hit at Stripe;
  //  3. `listTransferReversals` returns every recorded reversal WITH the
  //     metadata its request stamped.
  const transferState = new Map(
    [...(opts?.transfers ?? new Map())].map(
      ([id, s]) => [id, { ...s }] as const,
    ),
  );
  const reversalsByTransfer = new Map<
    string,
    Array<{
      reversalId: string;
      amountCents: number;
      metadata: Record<string, string>;
    }>
  >();
  const reversalsByIdemKey = new Map<
    string,
    { reversalId: string; amountCents: number | null }
  >();
  let reversalSeq = 0;

  const recordReversal = (
    transferId: string,
    amountCents: number,
    metadata: Record<string, string>,
  ) => {
    const reversalId = `trr_${++reversalSeq}`;
    const list = reversalsByTransfer.get(transferId) ?? [];
    list.push({ reversalId, amountCents, metadata });
    reversalsByTransfer.set(transferId, list);
    const state = transferState.get(transferId);
    if (state) state.amountReversedCents += amountCents;
    return reversalId;
  };

  const payments = {
    reverseTransfer: vi.fn(
      async (input: {
        transferId: string;
        amountCents?: number;
        metadata?: Record<string, string>;
        idempotencyKey?: string;
      }) => {
        if (input.idempotencyKey) {
          const prior = reversalsByIdemKey.get(input.idempotencyKey);
          if (prior) {
            if (prior.amountCents !== (input.amountCents ?? null)) {
              throw new Error(
                `stripe_idempotency_error_same_key_different_params:${input.idempotencyKey}`,
              );
            }
            return { reversalId: prior.reversalId };
          }
        }
        const state = transferState.get(input.transferId);
        const requested =
          input.amountCents ??
          (state ? state.amountCents - state.amountReversedCents : 0);
        if (state && state.amountReversedCents + requested > state.amountCents) {
          throw new Error(
            `stripe_transfer_reversal_exceeds_amount:${input.transferId}:${state.amountReversedCents + requested}>${state.amountCents}`,
          );
        }
        const reversalId = recordReversal(
          input.transferId,
          requested,
          input.metadata ?? {},
        );
        if (input.idempotencyKey) {
          reversalsByIdemKey.set(input.idempotencyKey, {
            reversalId,
            amountCents: input.amountCents ?? null,
          });
        }
        return { reversalId };
      },
    ),
    getTransfer: vi.fn(async (input: { transferId: string }) => {
      const state = transferState.get(input.transferId);
      return state
        ? {
            amountCents: state.amountCents,
            amountReversedCents: state.amountReversedCents,
          }
        : { amountCents: Number.MAX_SAFE_INTEGER, amountReversedCents: 0 };
    }),
    listTransferReversals: vi.fn(
      async (input: { transferId: string }) =>
        reversalsByTransfer.get(input.transferId) ?? [],
    ),
  } as unknown as PaymentProcessorPort;

  /**
   * Records a reversal made by SOMEONE ELSE (another operation/order on the
   * same transfer): consumes capacity and shows up in the reversal list with
   * foreign metadata, but was never issued through this call's keys.
   */
  const seedForeignReversal = (
    transferId: string,
    amountCents: number,
    metadata: Record<string, string> = {},
  ) => {
    recordReversal(transferId, amountCents, metadata);
  };

  return { repos, payments, transferState, seedForeignReversal };
}

describe("reverseTransfersForItems — ledger-era resolution", () => {
  it("uses the PAYEE-side credit attribution, IGNORING buyer-side itemAmounts, and sums shares into one call per transfer", async () => {
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem()],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 3_000, [ITEM_B]: 2_500 },
        },
      ],
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_A, ITEM_B],
        // Buyer-side amounts (fee/tax-inclusive) — a valid ledger-era
        // transfer never held these. They MUST be ignored: honouring them
        // requests more than the transfer holds and Stripe rejects, aborting
        // the buyer's refund.
        itemAmounts: new Map([
          [ITEM_A, 3_500],
          [ITEM_B, 3_100],
        ]),
        idempotencyKeyPrefix: "refund:xyz:reverse-transfer",
      },
    );

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith({
      transferId: "tr_ledger_1",
      amountCents: 5_500, // 3_000 + 2_500 attribution — NOT 6_600 buyer-side
      idempotencyKey: "refund:xyz:reverse-transfer:tr_ledger_1",
      metadata: {
        payoutItemId: "pitem-1",
        // Operation identity: recovery uses this to tell a retry of THIS
        // operation apart from another operation's reversal on the transfer.
        opKey: "refund:xyz:reverse-transfer",
        orderItemIds: `${ITEM_A},${ITEM_B}`,
        reason: "refund",
      },
    });

    // Ledger-era results: null settlementId, payee carried directly.
    expect(results).toEqual([
      {
        orderItemId: ITEM_A,
        settlementId: null,
        payoutItemId: "pitem-1",
        payeeId: "payee-1",
        stripeTransferId: "tr_ledger_1",
        reversalId: "trr_1",
        reversedCents: 3_000,
      },
      {
        orderItemId: ITEM_B,
        settlementId: null,
        payoutItemId: "pitem-1",
        payeeId: "payee-1",
        stripeTransferId: "tr_ledger_1",
        reversalId: "trr_1",
        reversedCents: 2_500,
      },
    ]);

    // Everything resolved through the plan → the frozen junction is never
    // consulted.
    expect(
      ctx.repos.orderItemSettlementLines.listByOrderItemIds,
    ).not.toHaveBeenCalled();
  });

  it("multi-payee overlap: BOTH payout items covering the same items are reversed, each for that payee's share", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          payoutItemId: "pitem-owner",
          stripeTransferId: "tr_owner",
          payeeId: "payee-owner",
          amountCents: 3_000,
          netAmountCents: 3_000,
          plannedOrderItemIds: [ITEM_A],
        }),
        makeLedgerPayoutItem({
          payoutItemId: "pitem-performer",
          stripeTransferId: "tr_performer",
          payeeId: "payee-performer",
          amountCents: 2_000,
          netAmountCents: 2_000,
          plannedOrderItemIds: [ITEM_A],
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-owner",
          items: { [ITEM_A]: 3_000 },
        },
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-performer",
          items: { [ITEM_A]: 2_000 },
        },
      ],
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      { orderItemIds: [ITEM_A] },
    );

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: "tr_owner", amountCents: 3_000 }),
    );
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_performer",
        amountCents: 2_000,
      }),
    );
    // The SAME order item appears in both payees' results — per-pair
    // resolution, never first-match-wins.
    expect(results.map((r) => [r.payeeId, r.reversedCents])).toEqual([
      ["payee-owner", 3_000],
      ["payee-performer", 2_000],
    ]);
  });

  it("caps the reversal at netAmountCents (sequential in plan order) — withheld cents are never requested", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          amountCents: 5_000,
          netAmountCents: 4_200, // 800 withheld — never left the platform
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 2_500, [ITEM_B]: 2_500 },
        },
      ],
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      { orderItemIds: [ITEM_A, ITEM_B] },
    );

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 4_200,
      }),
    );
    // Remainder policy: plan order — ITEM_A keeps its full share, ITEM_B
    // absorbs the shortfall. Per-item split only shapes audit granularity;
    // the per-payee sum (what the credit is written from) is the cap.
    expect(results.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_A, 2_500],
      [ITEM_B, 1_700],
    ]);
  });

  it("ignores a DIFFERENT payee's attribution and non-credit entries when deriving amounts", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({ plannedOrderItemIds: [ITEM_A], payeeId: "payee-1" }),
      ],
      orderEntries: [
        // The payee's credit attributes 4_200¢ of ITEM_A…
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 4_200 },
        },
        // …a DIFFERENT payee's attribution for the same item must be ignored…
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-2",
          items: { [ITEM_A]: 9_999 },
        },
        // …and non-credit entries never contribute.
        {
          type: "REFUND_DEBIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 1_234 },
        },
      ],
    });

    await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      { orderItemIds: [ITEM_A] },
    );

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 4_200,
      }),
    );
  });

  it("reports and skips a ledger-resolved item with no credit attribution, never guessing", async () => {
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ plannedOrderItemIds: [ITEM_A] })],
      orderEntries: [], // no credit attribution anywhere
    });
    const reportError = vi.fn();

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      { orderItemIds: [ITEM_A] },
    );

    expect(results).toEqual([]);
    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_no_amount_for_ledger_item",
      }),
      expect.objectContaining({
        tags: { useCase: "reverseTransfersForItems" },
        extra: expect.objectContaining({
          orderItemId: ITEM_A,
          payoutItemId: "pitem-1",
        }),
      }),
    );
  });

  it("a throwing reporter never changes behaviour on the miss arm", async () => {
    const ctx = makeContext(); // neither era resolves anything
    const reportError = vi.fn(() => {
      throw new Error("reporter exploded");
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      { orderItemIds: [ITEM_A] },
    );

    expect(results).toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("SEQUENTIAL REFUNDS: caps the request at Stripe's remaining capacity, read once per transfer", async () => {
    // The reviewer scenario's SECOND call: transfer sent 9_800 net
    // (10_000 payable − 200 withheld Connect fee); an earlier refund of
    // item A already reversed 6_000. This call requests B's 4_000 — the
    // per-call net cap (9_800) would let it through and Stripe would reject
    // the cumulative 10_000 > 9_800. The pre-flight reads remaining 3_800
    // and reverses exactly that; the 200 shortfall stays as ledger debt.
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          amountCents: 10_000,
          netAmountCents: 9_800,
          plannedOrderItemIds: [ITEM_B],
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_B]: 4_000 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_800, amountReversedCents: 6_000 }],
      ]),
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      { orderItemIds: [ITEM_B] },
    );

    expect(ctx.payments.getTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.getTransfer).toHaveBeenCalledWith({
      transferId: "tr_ledger_1",
    });
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 3_800,
      }),
    );
    // Σ reversedCents === the executed Stripe amount — this is what the
    // caller's TRANSFER_REVERSAL_CREDIT is written from.
    expect(results.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_B, 3_800],
    ]);
  });

  it("capacity clamp splits per-item sequentially in plan order — Σ reversedCents equals the executed amount", async () => {
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ netAmountCents: 10_000 })],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 2_500, [ITEM_B]: 2_500 },
        },
      ],
      transfers: new Map([
        // 6_000 of the 10_000 already reversed → 4_000 remaining < the
        // 5_000 this call requests.
        ["tr_ledger_1", { amountCents: 10_000, amountReversedCents: 6_000 }],
      ]),
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      { orderItemIds: [ITEM_A, ITEM_B] },
    );

    // ONE read for the transfer even though TWO items ride it.
    expect(ctx.payments.getTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 4_000,
      }),
    );
    // Plan order: ITEM_A keeps its full share, ITEM_B absorbs the shortfall.
    expect(results.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_A, 2_500],
      [ITEM_B, 1_500],
    ]);
  });

  it("ZERO remaining: skips the Stripe call with a distinct report; other transfers still reverse", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          payoutItemId: "pitem-full",
          stripeTransferId: "tr_full",
          payeeId: "payee-1",
          plannedOrderItemIds: [ITEM_A],
          amountCents: 5_000,
          netAmountCents: 5_000,
        }),
        makeLedgerPayoutItem({
          payoutItemId: "pitem-open",
          stripeTransferId: "tr_open",
          payeeId: "payee-2",
          plannedOrderItemIds: [ITEM_A],
          amountCents: 2_000,
          netAmountCents: 2_000,
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 5_000 },
        },
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-2",
          items: { [ITEM_A]: 2_000 },
        },
      ],
      transfers: new Map([
        ["tr_full", { amountCents: 5_000, amountReversedCents: 0 }],
        ["tr_open", { amountCents: 2_000, amountReversedCents: 0 }],
      ]),
    });
    // SOMEONE ELSE'S reversal exhausted tr_full — its metadata matches none
    // of this call's items, so recovery must NOT fire; skip + debt-carry.
    ctx.seedForeignReversal("tr_full", 5_000, {
      orderItemIds: "99999999-9999-4999-8999-999999999999",
    });
    const reportError = vi.fn();

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      { orderItemIds: [ITEM_A] },
    );

    // tr_full is never requested (Stripe would reject and abort the buyer's
    // refund); tr_open proceeds untouched.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: "tr_open", amountCents: 2_000 }),
    );
    expect(results.map((r) => [r.payeeId, r.reversedCents])).toEqual([
      ["payee-2", 2_000],
    ]);
    // Distinct signal — the payee-1 debit stands as debt, deliberately.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_transfer_fully_reversed",
      }),
      expect.objectContaining({
        tags: { useCase: "reverseTransfersForItems" },
        extra: expect.objectContaining({
          stripeTransferId: "tr_full",
          payoutItemId: "pitem-full",
          requestedCents: 5_000,
        }),
      }),
    );
  });

  it("RETRY RECOVERY (full): our prior reversal (results lost to a local failure) is reconstructed — no second Stripe call, no skip", async () => {
    // Attempt 1 reverses 10_000 at Stripe, then the local transaction fails
    // BEFORE the results are consumed (no TRANSFER_REVERSAL_CREDIT). The
    // retry's pre-flight reads remaining 0 — pre-recovery it would SKIP,
    // writing the retry's REFUND_DEBIT with no compensating credit and
    // recouping money the payee already returned. Recovery matches our
    // reversal by orderItemIds metadata and replays the results instead.
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ netAmountCents: 10_000 })],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 6_000, [ITEM_B]: 4_000 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 10_000, amountReversedCents: 0 }],
      ]),
    });
    const input = {
      orderItemIds: [ITEM_A, ITEM_B],
      idempotencyKeyPrefix: "refund:retry:reverse-transfer",
    };

    const first = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      input,
    );
    expect(first.reduce((sum, r) => sum + r.reversedCents, 0)).toBe(10_000);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    // …results of attempt 1 are DISCARDED (local failure) — retry:

    const reportError = vi.fn();
    const second = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      input,
    );

    // NO second Stripe reversal — the prior one is reused.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.listTransferReversals).toHaveBeenCalledTimes(1);
    // Results reconstructed exactly once with the identical per-item split
    // (re-derived from the same attribution plan) and the ORIGINAL
    // reversal id; Σ reversedCents === the recovered Stripe amount.
    expect(second).toEqual([
      expect.objectContaining({
        orderItemId: ITEM_A,
        reversedCents: 6_000,
        reversalId: "trr_1",
        payoutItemId: "pitem-1",
        payeeId: "payee-1",
      }),
      expect.objectContaining({
        orderItemId: ITEM_B,
        reversedCents: 4_000,
        reversalId: "trr_1",
      }),
    ]);
    expect(second.reduce((sum, r) => sum + r.reversedCents, 0)).toBe(10_000);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_recovered_prior_reversal",
      }),
      expect.objectContaining({
        tags: { useCase: "reverseTransfersForItems" },
        extra: expect.objectContaining({
          stripeTransferId: "tr_ledger_1",
          payoutItemId: "pitem-1",
          recoveredCents: 10_000,
          reversalIds: ["trr_1"],
        }),
      }),
    );
  });

  it("PARTIAL-CAP RETRY: a foreign reversal shrank remaining below our executed amount — ours is recovered, never re-requested under the same key", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          plannedOrderItemIds: [ITEM_A],
          netAmountCents: 9_800,
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 4_000 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_800, amountReversedCents: 0 }],
      ]),
    });
    const input = {
      orderItemIds: [ITEM_A],
      idempotencyKeyPrefix: "refund:retry2:reverse-transfer",
    };

    const first = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      input,
    );
    expect(first.map((r) => r.reversedCents)).toEqual([4_000]);

    // Between attempt 1 and the retry, another operation reverses 3_000 —
    // remaining drops to 2_800 < our executed 4_000. Without recovery the
    // retry would clamp to 2_800 and re-request under the SAME
    // `${prefix}:${transferId}` key: the stateful fake (like Stripe) throws
    // same-key-different-params for exactly that — pinning the sibling flaw.
    ctx.seedForeignReversal("tr_ledger_1", 3_000, {
      orderItemIds: "99999999-9999-4999-8999-999999999999",
    });

    const second = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      input,
    );

    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1); // no new call
    expect(second).toEqual([
      expect.objectContaining({
        orderItemId: ITEM_A,
        reversedCents: 4_000,
        reversalId: "trr_1",
      }),
    ]);
  });

  it("a DIFFERENT refund operation on the same transfer matches nothing → fresh clamped request under its OWN key", async () => {
    // Idempotency-key safety, pinned: reversal keys are
    // `${idempotencyKeyPrefix}:${transferId}` and every caller derives the
    // prefix from the refund OPERATION (e.g.
    // `order:refund-items:{orderId}:{actor}:items:{ids}:reverse-transfer`),
    // so operation 2 clamping on a transfer operation 1 partially reversed
    // can never collide with operation 1's Stripe key.
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ netAmountCents: 9_800 })],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 6_000, [ITEM_B]: 4_000 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_800, amountReversedCents: 0 }],
      ]),
    });

    const first = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_A],
        idempotencyKeyPrefix: "refund:op1:reverse-transfer",
      },
    );
    expect(first.map((r) => r.reversedCents)).toEqual([6_000]);

    const second = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_B],
        idempotencyKeyPrefix: "refund:op2:reverse-transfer",
      },
    );

    // Operation 1's reversal metadata (orderItemIds = ITEM_A) does not
    // intersect {ITEM_B} → NOT a retry → genuine capacity consumption →
    // clamp to the remaining 3_800 and issue fresh under op2's key.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
    expect(ctx.payments.reverseTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 3_800,
        idempotencyKey: "refund:op2:reverse-transfer:tr_ledger_1",
      }),
    );
    expect(second.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_B, 3_800],
    ]);
  });

  it("FOREIGN-OVERLAP: another op's crashed reversal on a shared item is NOT reconstructed — this op issues its own clamped reversal", async () => {
    // The reviewer's exact scenario. Transfer holds 9_500 net. Op1 (staff
    // refund, item A) reversed 5_000 (metadata: orderItemIds=A, opKey=op1)
    // and crashed pre-commit — A stays refundable and lands in op2's set.
    // Op2 (buyer full refund, plan A 5_000 + B 4_500 = 9_500) pre-flights:
    // remaining 4_500 < 9_500. Under item-overlap-alone matching, op1's
    // reversal would be "recovered" as [A: 5_000] and B's 4_500 would NEVER
    // be reversed despite sitting recoverable on the transfer. With opKey
    // classification, op1's reversal is FOREIGN → mere capacity
    // consumption → op2 issues its OWN fresh 4_500 reversal (its
    // `${prefix}:${transferId}` key was never used — no collision).
    //
    // Split traced: the foreign reversal already returned A's cents, so
    // op2's fresh 4_500 is attributed to the item the foreign reversal did
    // NOT cover — B — not to A again (foreign-covered items go last in the
    // sequential split). Per-payee sum (4_500) is identical either way.
    // Caller-side arithmetic: debits 9_500, reversal credit 4_500 → the
    // payee carries 5_000 as debt until/unless op1's op is retried.
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ netAmountCents: 9_500 })],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 5_000, [ITEM_B]: 4_500 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_500, amountReversedCents: 0 }],
      ]),
    });

    // Op1: staff refund of item A alone — reverses 5_000, then crashes
    // before commit (results discarded, A not marked refunded).
    const op1 = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_A],
        idempotencyKeyPrefix: "order:staff-refund:op1:reverse-transfer",
      },
    );
    expect(op1.map((r) => r.reversedCents)).toEqual([5_000]);

    // Op2: buyer full refund covering A AND B.
    const op2 = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_A, ITEM_B],
        idempotencyKeyPrefix: "order:refund-full:op2:reverse-transfer",
      },
    );

    // Fresh reversal for the genuine remaining 4_500 under op2's own key —
    // nothing reconstructed from op1's reversal.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(2);
    expect(ctx.payments.reverseTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 4_500,
        idempotencyKey: "order:refund-full:op2:reverse-transfer:tr_ledger_1",
        metadata: expect.objectContaining({
          opKey: "order:refund-full:op2:reverse-transfer",
          orderItemIds: ITEM_B,
        }),
      }),
    );
    expect(op2.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_B, 4_500],
    ]);
  });

  it("DEPLOY BOUNDARY: a pre-opKey reversal whose items this call covers (pure-retry shape) still reconstructs", async () => {
    // Reversals issued before opKey stamping carry no operation identity.
    // Heuristic (expires once all pre-deploy reversals age out): item set
    // covered by this call ⇒ treat as OUR earlier attempt → reconstruct.
    const ctx = makeContext({
      payoutItems: [makeLedgerPayoutItem({ netAmountCents: 9_500 })],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 5_000, [ITEM_B]: 4_500 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_500, amountReversedCents: 0 }],
      ]),
    });
    // Legacy-shaped prior reversal: full 9_500, orderItemIds only, NO opKey.
    ctx.seedForeignReversal("tr_ledger_1", 9_500, {
      orderItemIds: `${ITEM_A},${ITEM_B}`,
    });
    const reportError = vi.fn();

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      {
        orderItemIds: [ITEM_A, ITEM_B],
        idempotencyKeyPrefix: "order:refund-full:retry:reverse-transfer",
      },
    );

    expect(ctx.payments.reverseTransfer).not.toHaveBeenCalled();
    expect(results.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_A, 5_000],
      [ITEM_B, 4_500],
    ]);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_recovered_prior_reversal",
      }),
      expect.anything(),
    );
  });

  it("DEPLOY BOUNDARY: a pre-opKey reversal spanning items OUTSIDE this call is treated as foreign", async () => {
    // A no-opKey reversal covering an item this call does NOT include can
    // only be another operation's — clamp a fresh request, don't reconstruct.
    const FOREIGN_ITEM = "99999999-9999-4999-8999-999999999999";
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          plannedOrderItemIds: [ITEM_B],
          netAmountCents: 9_500,
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_B]: 4_500 },
        },
      ],
      transfers: new Map([
        ["tr_ledger_1", { amountCents: 9_500, amountReversedCents: 0 }],
      ]),
    });
    // Non-superset overlap: covers ITEM_B AND an item this call doesn't.
    ctx.seedForeignReversal("tr_ledger_1", 6_000, {
      orderItemIds: `${ITEM_B},${FOREIGN_ITEM}`,
    });

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments },
      {
        orderItemIds: [ITEM_B],
        idempotencyKeyPrefix: "order:refund-items:opB:reverse-transfer",
      },
    );

    // Fresh clamped request for the remaining 3_500 under this op's key.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 3_500,
        idempotencyKey: "order:refund-items:opB:reverse-transfer:tr_ledger_1",
      }),
    );
    expect(results.map((r) => [r.orderItemId, r.reversedCents])).toEqual([
      [ITEM_B, 3_500],
    ]);
  });

  it("a failing capacity read is reported and falls back to the per-call cap — the refund is never aborted by the pre-flight", async () => {
    const ctx = makeContext({
      payoutItems: [
        makeLedgerPayoutItem({
          plannedOrderItemIds: [ITEM_A],
          netAmountCents: 9_800,
        }),
      ],
      orderEntries: [
        {
          type: "SETTLEMENT_CREDIT",
          payeeId: "payee-1",
          items: { [ITEM_A]: 4_000 },
        },
      ],
    });
    (
      ctx.payments.getTransfer as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("stripe_down"));
    const reportError = vi.fn();

    const results = await reverseTransfersForItems(
      { repos: ctx.repos, payments: ctx.payments, reportError },
      { orderItemIds: [ITEM_A] },
    );

    // Pre-read behaviour: the netAmountCents-capped request is issued as-is;
    // if the transfer truly lacked capacity Stripe would reject it loudly.
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(ctx.payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_ledger_1",
        amountCents: 4_000,
      }),
    );
    expect(results.map((r) => r.reversedCents)).toEqual([4_000]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_capacity_read_failed",
      }),
      expect.objectContaining({
        tags: { useCase: "reverseTransfersForItems" },
        extra: expect.objectContaining({
          stripeTransferId: "tr_ledger_1",
          error: "stripe_down",
        }),
      }),
    );
  });

  it("LEGACY junction arm: never reads capacity — pre-cutover behaviour is byte-identical", async () => {
    const repos = {
      payoutItems: {
        listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
      },
      orderItemSettlementLines: {
        listByOrderItemIds: vi.fn(async () => [
          {
            id: "oisl-1",
            orderItemId: ITEM_A,
            settlementLineId: "sl-1",
            amountCents: 5_000,
          },
        ]),
      },
      settlementLines: {
        getByIds: vi.fn(async () => [{ id: "sl-1", settlementId: "st-1" }]),
      },
      settlements: {
        getByIds: vi.fn(async () => [
          { id: "st-1", stripeTransferId: "tr_legacy_1" },
        ]),
      },
    } as unknown as Repos;
    const payments = {
      reverseTransfer: vi.fn(async () => ({ reversalId: "trr_legacy" })),
      getTransfer: vi.fn(async () => ({
        amountCents: 1, // would clamp everything if (wrongly) consulted
        amountReversedCents: 0,
      })),
      listTransferReversals: vi.fn(async () => []),
    } as unknown as PaymentProcessorPort;

    const results = await reverseTransfersForItems(
      { repos, payments },
      { orderItemIds: [ITEM_A] },
    );

    expect(payments.getTransfer).not.toHaveBeenCalled();
    expect(payments.listTransferReversals).not.toHaveBeenCalled();
    expect(payments.reverseTransfer).toHaveBeenCalledTimes(1);
    expect(payments.reverseTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr_legacy_1",
        amountCents: 5_000,
      }),
    );
    expect(results.map((r) => r.reversedCents)).toEqual([5_000]);
  });

  it("reports a junction dead-end (broken settlement chain) instead of only warning", async () => {
    const repos = {
      payoutItems: {
        listTransferredByPlannedOrderItemIds: vi.fn(async () => []),
      },
      orderItemSettlementLines: {
        listByOrderItemIds: vi.fn(async () => [
          {
            id: "oisl-1",
            orderItemId: ITEM_A,
            settlementLineId: "sl-missing",
            amountCents: 5_000,
          },
        ]),
      },
      // The chain dead-ends: the settlement line row is gone.
      settlementLines: { getByIds: vi.fn(async () => []) },
      settlements: { getByIds: vi.fn(async () => []) },
    } as unknown as Repos;
    const payments = {
      reverseTransfer: vi.fn(async () => ({ reversalId: "trr_x" })),
    } as unknown as PaymentProcessorPort;
    const reportError = vi.fn();

    const results = await reverseTransfersForItems(
      { repos, payments, reportError },
      { orderItemIds: [ITEM_A] },
    );

    expect(results).toEqual([]);
    expect(payments.reverseTransfer).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "reverse_transfers_settlement_line_not_found",
      }),
      expect.objectContaining({
        tags: { useCase: "reverseTransfersForItems" },
        extra: expect.objectContaining({
          settlementLineId: "sl-missing",
          orderItemId: ITEM_A,
        }),
      }),
    );
  });
});
