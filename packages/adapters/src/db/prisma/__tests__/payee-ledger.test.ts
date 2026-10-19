import { describe, expect, it } from "vitest";

import type { PayeeLedgerBalance, PayeeLedgerEntry } from "@prisma/client";

import { Prisma } from "@prisma/client";

import { RESALE_CLAIM_WINDOW_DAYS } from "@th/types/repos/resale-listings";
import { resaleClaimWindowClosesAt } from "@th/core/lib/resale-claim-window";

import {
  buildFilteredEntriesSql,
  buildUpcomingMaturitiesSql,
  CREDIT_EFFECTIVE_MATURITY_SQL,
  CREDIT_NOT_BLOCKED_SQL,
  creditMaturedSql,
  makePayeeLedgerRepo,
} from "../payee-ledger";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-05-15T12:00:00.000Z");

describe("makePayeeLedgerRepo", () => {
  it("does not double-adjust pending holds when a hold idempotency key replays", async () => {
    const { repo, entriesById } = createHarness();

    const first = await repo.hold(buildHoldInput());
    const second = await repo.hold(buildHoldInput());
    const balance = await repo.getBalance("payee_1", "USD");

    expect(second).toEqual(first);
    expect([...entriesById.values()]).toHaveLength(1);
    expect(balance).toMatchObject({
      payeeId: "payee_1",
      currency: "usd",
      ledgerBalanceCents: 0,
      pendingHoldCents: 5_000,
      reserveCents: 0,
      availableCents: -5_000,
    });
  });

  it("releases a hold and decreases pending holds once", async () => {
    const { repo, entriesById } = createHarness();
    const hold = await repo.hold(buildHoldInput());

    const release = await repo.releaseHold({ holdEntryId: hold.id });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(release).toMatchObject({
      type: "DISPUTE_RELEASE",
      amountCents: 5_000,
      relatedEntryId: hold.id,
      idempotencyKey: `dispute-release:dispute_1:${hold.id}`,
    });
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(1);
    expect(balance.pendingHoldCents).toBe(0);
    expect(balance.availableCents).toBe(0);
  });

  it("does not double-decrease pending holds when a release replays", async () => {
    const { repo, entriesById } = createHarness();
    const hold = await repo.hold(buildHoldInput());

    const firstRelease = await repo.releaseHold({ holdEntryId: hold.id });
    const secondRelease = await repo.releaseHold({ holdEntryId: hold.id });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(secondRelease).toEqual(firstRelease);
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(1);
    expect(balance.pendingHoldCents).toBe(0);
  });

  it("does not release an already consumed hold with a different idempotency key", async () => {
    const { repo, entriesById } = createHarness();
    const hold = await repo.hold(buildHoldInput());

    const firstRelease = await repo.releaseHold({
      holdEntryId: hold.id,
      idempotencyKey: "release-key-1",
    });
    const secondRelease = await repo.releaseHold({
      holdEntryId: hold.id,
      idempotencyKey: "release-key-2",
    });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(secondRelease).toEqual(firstRelease);
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(1);
    expect(balance.pendingHoldCents).toBe(0);
  });

  it("returns the consumed release when a related-entry unique conflict wins the race", async () => {
    const { repo, entriesById, executeRawCalls } = createHarness({
      consumeHoldDuringNextReleaseCreate: true,
    });
    const hold = await repo.hold(buildHoldInput());

    const release = await repo.releaseHold({
      holdEntryId: hold.id,
      idempotencyKey: "release-key-after-race",
    });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(release).toMatchObject({
      type: "DISPUTE_RELEASE",
      relatedEntryId: hold.id,
      idempotencyKey: "release-key-that-won-race",
    });
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(1);
    expect(balance.pendingHoldCents).toBe(0);
    expect(executeRawCalls).toHaveLength(0);
  });

  // ── DISPUTE_DEBIT ───────────────────────────────────────────────────────
  // Sign convention: the entry stores a POSITIVE amount (the type carries
  // direction, like holds/releases); the balance rollup moves instead —
  // ledgerBalanceCents drops by the debit, and a consumed hold's pending
  // effect is removed so hold→debit never double-counts against available.

  it("debits after a hold: consumes the hold and moves both rollups", async () => {
    const { repo, entriesById } = createHarness();
    const hold = await repo.hold(buildHoldInput());

    const debit = await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    const balance = await repo.getBalance("payee_1", "usd");

    expect(debit).toMatchObject({
      type: "DISPUTE_DEBIT",
      amountCents: 6_500,
      currency: "usd",
      relatedEntryId: hold.id,
      idempotencyKey: "dispute-debit:dispute_1:payee_1:usd",
    });
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(1);
    // hold consumed: pending back to 0; balance carries the full debit.
    expect(balance).toMatchObject({
      ledgerBalanceCents: -6_500,
      pendingHoldCents: 0,
      availableCents: -6_500,
    });
  });

  it("replays a debit without re-applying balance effects", async () => {
    const { repo, entriesById } = createHarness();
    await repo.hold(buildHoldInput());

    const first = await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    const second = await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_DEBIT"),
    ).toHaveLength(1);
    expect(balance).toMatchObject({
      ledgerBalanceCents: -6_500,
      pendingHoldCents: 0,
      availableCents: -6_500,
    });
  });

  it("debits directly with no prior hold, moving only the ledger balance", async () => {
    const { repo } = createHarness();

    const debit = await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    const balance = await repo.getBalance("payee_1", "usd");

    expect(debit).toMatchObject({
      type: "DISPUTE_DEBIT",
      amountCents: 6_500,
      relatedEntryId: null,
    });
    expect(balance).toMatchObject({
      ledgerBalanceCents: -6_500,
      pendingHoldCents: 0,
      availableCents: -6_500,
    });
  });

  it("rejects non-positive debit amounts", async () => {
    const { repo } = createHarness();

    await expect(repo.debit(buildDebitInput({ amountCents: 0 }))).rejects.toThrow(
      "payee_ledger_debit_amount_must_be_positive",
    );
    await expect(
      repo.debit(buildDebitInput({ amountCents: -100 })),
    ).rejects.toThrow("payee_ledger_debit_amount_must_be_positive");
  });

  it("leaves the ledger untouched when holds are released after a debit consumed them", async () => {
    const { repo, entriesById } = createHarness();
    await repo.hold(buildHoldInput());
    await repo.debit(buildDebitInput({ amountCents: 6_500 }));

    const releases = await repo.releaseHoldsForDispute("dispute_1");
    const balance = await repo.getBalance("payee_1", "usd");

    expect(releases).toHaveLength(0);
    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(0);
    expect(balance).toMatchObject({
      ledgerBalanceCents: -6_500,
      pendingHoldCents: 0,
      availableCents: -6_500,
    });
  });

  it("atomically decrements pending holds when two holds release concurrently", async () => {
    const { repo, entriesById } = createHarness();
    const firstHold = await repo.hold(buildHoldInput());
    const secondHold = await repo.hold(
      buildHoldInput({
        idempotencyKey: "dispute-hold:dispute_2:payee_1:usd",
        disputeId: "dispute_2",
        orderId: "order_2",
      }),
    );

    await Promise.all([
      repo.releaseHold({ holdEntryId: firstHold.id }),
      repo.releaseHold({ holdEntryId: secondHold.id }),
    ]);
    const balance = await repo.getBalance("payee_1", "usd");

    expect(
      [...entriesById.values()].filter((entry) => entry.type === "DISPUTE_RELEASE"),
    ).toHaveLength(2);
    expect(balance.pendingHoldCents).toBe(0);
    expect(balance.availableCents).toBe(0);
  });

  // `recoverDebt` — the pre-cutover writer that squared dispute-debt back onto
  // the ledger with a positive PAYOUT entry — is DELETED (spec 2026-08-10 §7).
  // Debt is now simply a NEGATIVE payable that pays nothing and is recouped by
  // the next cycle's arithmetic, so there is no squaring entry to write and no
  // crash sweep to replay it. The only surviving trace is the reserved
  // `debt-recovery:` key namespace, asserted below (payoutDebit refuses it) and
  // in the payable-query integration test (legacy rows still read POSITIVE).

  // ── reverseDisputeDebit (WON-after-LOST) ────────────────────────────────
  // A second close can flip LOST→WON after the hold was already consumed by
  // a realised debit; the reversal is the compensating positive entry. Typed
  // DISPUTE_RELEASE (the dispute's claim is released — getBalance reads only
  // the rollup, so the type is semantic) but with the DEBIT's balance
  // direction inverted: ledgerBalanceCents goes UP, pending holds untouched.

  it("reverses a debit: DISPUTE_RELEASE linked to the debit, balance restored, holds untouched", async () => {
    const { repo, entriesById } = createHarness();
    await repo.hold(buildHoldInput());
    const debit = await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    const before = await repo.getBalance("payee_1", "usd");
    expect(before.ledgerBalanceCents).toBe(-6_500);

    const reversal = await repo.reverseDisputeDebit(
      buildReverseDebitInput({ debitEntryId: debit.id }),
    );
    const after = await repo.getBalance("payee_1", "usd");

    expect(reversal).toMatchObject({
      type: "DISPUTE_RELEASE",
      amountCents: 6_500,
      currency: "usd",
      disputeId: "dispute_1",
      relatedEntryId: debit.id,
      idempotencyKey: "dispute-debit-reversal:dispute_1:payee_1:usd",
    });
    expect(after.ledgerBalanceCents).toBe(0);
    expect(after.pendingHoldCents).toBe(before.pendingHoldCents);
    expect(
      [...entriesById.values()].filter(
        (entry) => entry.idempotencyKey === reversal.idempotencyKey,
      ),
    ).toHaveLength(1);
  });

  it("replays a debit reversal without re-applying balance effects", async () => {
    const { repo } = createHarness();
    const debit = await repo.debit(buildDebitInput({ amountCents: 6_500 }));

    const first = await repo.reverseDisputeDebit(
      buildReverseDebitInput({ debitEntryId: debit.id }),
    );
    const second = await repo.reverseDisputeDebit(
      buildReverseDebitInput({ debitEntryId: debit.id }),
    );
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    // -6500 debit + 6500 reversal, applied exactly once.
    expect(balance.ledgerBalanceCents).toBe(0);
  });

  it("rejects non-positive reversal amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.reverseDisputeDebit(
        buildReverseDebitInput({ amountCents: 0, debitEntryId: "x" }),
      ),
    ).rejects.toThrow("payee_ledger_debit_reversal_amount_must_be_positive");
  });

  it("lists only DISPUTE_DEBIT entries for the dispute", async () => {
    const { repo } = createHarness();
    await repo.hold(buildHoldInput());
    await repo.debit(buildDebitInput({ amountCents: 6_500 }));
    await repo.debit(
      buildDebitInput({
        amountCents: 1_500,
        idempotencyKey: "dispute-debit-fee:dispute_1:payee_1:usd",
      }),
    );
    // A different dispute's debit must not leak in.
    await repo.debit(
      buildDebitInput({
        amountCents: 2_000,
        idempotencyKey: "dispute-debit:dispute_2:payee_1:usd",
        disputeId: "dispute_2",
      }),
    );

    const debits = await repo.listDebitsForDispute("dispute_1");

    expect(debits.map((entry) => entry.idempotencyKey)).toEqual([
      "dispute-debit:dispute_1:payee_1:usd",
      "dispute-debit-fee:dispute_1:payee_1:usd",
    ]);
    expect(debits.every((entry) => entry.type === "DISPUTE_DEBIT")).toBe(true);
  });

  // ── Rolling reserve: RESERVE_HOLD / RESERVE_RELEASE ─────────────────────
  // Rollup semantics under test: a hold moves ONLY reserveBalanceCents (up);
  // a release moves it back down (floored at 0). ledgerBalanceCents is never
  // touched by either — the deferred cents were withheld before the
  // transfer, so the ledger balance never saw them.

  it("reserveHold: writes a RESERVE_HOLD and increments only the reserve rollup", async () => {
    const { repo } = createHarness();

    const hold = await repo.reserveHold(buildReserveHoldInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(hold).toMatchObject({
      type: "RESERVE_HOLD",
      amountCents: 500,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      idempotencyKey: "reserve-hold:payout_item_1",
      relatedEntryId: null,
    });
    expect(balance).toMatchObject({
      ledgerBalanceCents: 0,
      pendingHoldCents: 0,
      reserveCents: 500,
    });
  });

  it("reserveHold: replays without re-applying the rollup", async () => {
    const { repo, entriesById } = createHarness();

    const first = await repo.reserveHold(buildReserveHoldInput());
    const second = await repo.reserveHold(buildReserveHoldInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "RESERVE_HOLD"),
    ).toHaveLength(1);
    expect(balance.reserveCents).toBe(500);
  });

  it("reserveHold: rejects non-positive amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.reserveHold(buildReserveHoldInput({ amountCents: 0 })),
    ).rejects.toThrow("payee_ledger_reserve_hold_amount_must_be_positive");
  });

  it("reserveRelease: links hold → release, decrements the rollup, amount comes from the hold", async () => {
    const { repo } = createHarness();
    const hold = await repo.reserveHold(buildReserveHoldInput());

    const release = await repo.reserveRelease({
      idempotencyKey: `reserve-release:${hold.id}`,
      holdEntryId: hold.id,
      payoutItemId: "payout_item_2",
    });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(release).toMatchObject({
      type: "RESERVE_RELEASE",
      amountCents: 500, // from the HOLD, never caller-supplied
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_2", // the item CARRYING the money back
      relatedEntryId: hold.id,
    });
    expect(balance.reserveCents).toBe(0);
    expect(balance.ledgerBalanceCents).toBe(0);
  });

  it("reserveRelease: replays without re-applying the rollup", async () => {
    const { repo, entriesById } = createHarness();
    await repo.reserveHold(buildReserveHoldInput({ amountCents: 700 }));
    await repo.reserveHold(
      buildReserveHoldInput({
        idempotencyKey: "reserve-hold:payout_item_1b",
        payoutItemId: "payout_item_1b",
        amountCents: 300,
      }),
    );
    const holds = await repo.listUnreleasedReserveHolds(["payee_1"]);
    const target = holds[0]!;

    const first = await repo.reserveRelease({
      idempotencyKey: `reserve-release:${target.id}`,
      holdEntryId: target.id,
      payoutItemId: "payout_item_2",
    });
    const second = await repo.reserveRelease({
      idempotencyKey: `reserve-release:${target.id}`,
      holdEntryId: target.id,
      payoutItemId: "payout_item_2",
    });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "RESERVE_RELEASE"),
    ).toHaveLength(1);
    // 700 + 300 held, 700 released exactly once.
    expect(balance.reserveCents).toBe(300);
  });

  it("reserveRelease: a hold already released under ANOTHER key returns the existing release", async () => {
    const { repo, entriesById } = createHarness();
    const hold = await repo.reserveHold(buildReserveHoldInput());

    const first = await repo.reserveRelease({
      idempotencyKey: "release-key-a",
      holdEntryId: hold.id,
      payoutItemId: "payout_item_2",
    });
    const second = await repo.reserveRelease({
      idempotencyKey: "release-key-b",
      holdEntryId: hold.id,
      payoutItemId: "payout_item_3",
    });
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "RESERVE_RELEASE"),
    ).toHaveLength(1);
    expect(balance.reserveCents).toBe(0);
  });

  it("reserveRelease: throws for an unknown or non-hold entry id", async () => {
    const { repo } = createHarness();
    const debit = await repo.debit(buildDebitInput({ amountCents: 100 }));

    await expect(
      repo.reserveRelease({
        idempotencyKey: "release-key-x",
        holdEntryId: "nope",
        payoutItemId: "payout_item_2",
      }),
    ).rejects.toThrow("payee_ledger_reserve_release_hold_not_found");
    await expect(
      repo.reserveRelease({
        idempotencyKey: "release-key-y",
        holdEntryId: debit.id,
        payoutItemId: "payout_item_2",
      }),
    ).rejects.toThrow("payee_ledger_reserve_release_hold_not_found");
  });

  it("listUnreleasedReserveHolds: oldest-first, released holds drop out, other payees excluded", async () => {
    const { repo } = createHarness();
    const holdA = await repo.reserveHold(buildReserveHoldInput());
    await repo.reserveHold(
      buildReserveHoldInput({
        idempotencyKey: "reserve-hold:payout_item_1b",
        payoutItemId: "payout_item_1b",
        amountCents: 300,
      }),
    );
    await repo.reserveHold(
      buildReserveHoldInput({
        idempotencyKey: "reserve-hold:other_payee_item",
        payeeId: "payee_2",
        payoutItemId: "other_payee_item",
      }),
    );

    const before = await repo.listUnreleasedReserveHolds(["payee_1"]);
    expect(before.map((h) => h.sourceId)).toEqual([
      "payout_item_1",
      "payout_item_1b",
    ]);

    await repo.reserveRelease({
      idempotencyKey: `reserve-release:${holdA.id}`,
      holdEntryId: holdA.id,
      payoutItemId: "payout_item_2",
    });

    const after = await repo.listUnreleasedReserveHolds(["payee_1"]);
    expect(after.map((h) => h.sourceId)).toEqual(["payout_item_1b"]);
  });

  // ── Ledger-authoritative foundation: SETTLEMENT_CREDIT / REFUND_DEBIT /
  // TRANSFER_REVERSAL_CREDIT / new PAYOUT / markCreditsConsumed ────────────
  // Sign convention is file-wide: entries store POSITIVE amounts, the type
  // (plus operation) carries direction. Credits carry `availableAt` maturity
  // on the ENTRY only — the un-dated rollup counts them immediately (it is
  // the reconciliation cross-check, never a transfer input).

  it("settlementCredit: writes the credit with maturity and increments the balance", async () => {
    const { repo } = createHarness();

    const credit = await repo.settlementCredit(buildSettlementCreditInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(credit).toMatchObject({
      type: "SETTLEMENT_CREDIT",
      amountCents: 10_000,
      currency: "usd",
      orderId: "order_1",
      sourceKind: "order_split",
      sourceId: "order_1",
      availableAt: new Date("2026-06-01T00:00:00.000Z"),
      consumedByEntryId: null,
      idempotencyKey: "settlement-credit:order_1:payee_1",
    });
    expect(balance).toMatchObject({
      ledgerBalanceCents: 10_000,
      pendingHoldCents: 0,
      availableCents: 10_000,
    });
  });

  it("settlementCredit: replays without re-applying balance effects", async () => {
    const { repo, entriesById } = createHarness();

    const first = await repo.settlementCredit(buildSettlementCreditInput());
    const second = await repo.settlementCredit(buildSettlementCreditInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "SETTLEMENT_CREDIT"),
    ).toHaveLength(1);
    expect(balance.ledgerBalanceCents).toBe(10_000);
  });

  it("settlementCredit: rejects non-positive amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.settlementCredit(buildSettlementCreditInput({ amountCents: 0 })),
    ).rejects.toThrow("payee_ledger_settlement_credit_amount_must_be_positive");
    await expect(
      repo.settlementCredit(buildSettlementCreditInput({ amountCents: -1 })),
    ).rejects.toThrow("payee_ledger_settlement_credit_amount_must_be_positive");
  });

  it("refundDebit: decrements the balance and never touches pending holds", async () => {
    const { repo } = createHarness();
    await repo.hold(buildHoldInput()); // stray active hold must stay untouched
    await repo.settlementCredit(buildSettlementCreditInput());

    const debit = await repo.refundDebit(buildRefundDebitInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(debit).toMatchObject({
      type: "REFUND_DEBIT",
      amountCents: 4_000,
      currency: "usd",
      orderId: "order_1",
      sourceKind: "refund",
      sourceId: "refund_1",
      availableAt: null,
      relatedEntryId: null,
      idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
    });
    expect(balance).toMatchObject({
      ledgerBalanceCents: 6_000,
      pendingHoldCents: 5_000, // the dispute hold, untouched by the refund
    });
  });

  it("refundDebit: replays without re-applying balance effects", async () => {
    const { repo, entriesById } = createHarness();

    const first = await repo.refundDebit(buildRefundDebitInput());
    const second = await repo.refundDebit(buildRefundDebitInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "REFUND_DEBIT"),
    ).toHaveLength(1);
    // Negative — a debt position, applied exactly once, never clamped.
    expect(balance.ledgerBalanceCents).toBe(-4_000);
  });

  it("refundDebit: rejects non-positive amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.refundDebit(buildRefundDebitInput({ amountCents: 0 })),
    ).rejects.toThrow("payee_ledger_refund_debit_amount_must_be_positive");
  });

  it("listOrderEntries: returns only the order's refund-relevant types, createdAt asc", async () => {
    const { repo } = createHarness();
    // Same order, all four candidate types — the DISPUTE_HOLD (orderId
    // "order_1" too) must be EXCLUDED: holds never enter refund arithmetic.
    await repo.hold(buildHoldInput());
    const credit = await repo.settlementCredit(buildSettlementCreditInput());
    const debit = await repo.refundDebit(buildRefundDebitInput());
    const reversal = await repo.transferReversalCredit(
      buildTransferReversalCreditInput({ relatedEntryId: debit.id }),
    );
    // A different order's credit must not leak in.
    await repo.settlementCredit(
      buildSettlementCreditInput({
        idempotencyKey: "settlement-credit:order_2:payee_1",
        orderId: "order_2",
        sourceId: "order_2",
      }),
    );

    const entries = await repo.listOrderEntries("order_1");

    expect(entries.map((e) => e.id)).toEqual([credit.id, debit.id, reversal.id]);
    expect(entries.map((e) => e.type)).toEqual([
      "SETTLEMENT_CREDIT",
      "REFUND_DEBIT",
      "TRANSFER_REVERSAL_CREDIT",
    ]);
    expect(entries.every((e) => e.orderId === "order_1")).toBe(true);
  });

  it("listOrderEntries: returns [] for an order with no ledger entries", async () => {
    const { repo } = createHarness();

    await expect(repo.listOrderEntries("order_absent")).resolves.toEqual([]);
  });

  it("transferReversalCredit: compensates the refund debit and links to it", async () => {
    const { repo } = createHarness();
    const debit = await repo.refundDebit(buildRefundDebitInput());

    const reversal = await repo.transferReversalCredit(
      buildTransferReversalCreditInput({ relatedEntryId: debit.id }),
    );
    const balance = await repo.getBalance("payee_1", "usd");

    expect(reversal).toMatchObject({
      type: "TRANSFER_REVERSAL_CREDIT",
      amountCents: 4_000,
      currency: "usd",
      orderId: "order_1",
      relatedEntryId: debit.id,
      // Defaults: sourceKind "transfer_reversal", sourceId = the debit id.
      sourceKind: "transfer_reversal",
      sourceId: debit.id,
      availableAt: null,
    });
    // Debit + reversal net to zero — the money came back externally.
    expect(balance.ledgerBalanceCents).toBe(0);
    expect(balance.pendingHoldCents).toBe(0);
  });

  it("transferReversalCredit: replays without re-applying balance effects", async () => {
    const { repo, entriesById } = createHarness();
    const debit = await repo.refundDebit(buildRefundDebitInput());

    const first = await repo.transferReversalCredit(
      buildTransferReversalCreditInput({ relatedEntryId: debit.id }),
    );
    const second = await repo.transferReversalCredit(
      buildTransferReversalCreditInput({ relatedEntryId: debit.id }),
    );
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter(
        (e) => e.type === "TRANSFER_REVERSAL_CREDIT",
      ),
    ).toHaveLength(1);
    expect(balance.ledgerBalanceCents).toBe(0);
  });

  it("transferReversalCredit: rejects non-positive amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.transferReversalCredit(
        buildTransferReversalCreditInput({ amountCents: 0, relatedEntryId: "x" }),
      ),
    ).rejects.toThrow(
      "payee_ledger_transfer_reversal_credit_amount_must_be_positive",
    );
  });

  it("payoutDebit: writes a PAYOUT with a NEGATIVE balance effect (unlike the deleted legacy debt-recovery writer)", async () => {
    const { repo } = createHarness();
    await repo.settlementCredit(buildSettlementCreditInput());

    const payout = await repo.payoutDebit(buildPayoutDebitInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(payout).toMatchObject({
      type: "PAYOUT",
      amountCents: 10_000,
      currency: "usd",
      sourceKind: "payout_item",
      sourceId: "payout_item_1",
      idempotencyKey: "payout:payout_item_1",
      orderId: null,
      availableAt: null,
    });
    // 10_000 credit − 10_000 payout: money left, the balance says so.
    expect(balance.ledgerBalanceCents).toBe(0);
  });

  it("payoutDebit: replays without re-applying balance effects", async () => {
    const { repo, entriesById } = createHarness();
    await repo.settlementCredit(buildSettlementCreditInput());

    const first = await repo.payoutDebit(buildPayoutDebitInput());
    const second = await repo.payoutDebit(buildPayoutDebitInput());
    const balance = await repo.getBalance("payee_1", "usd");

    expect(second).toEqual(first);
    expect(
      [...entriesById.values()].filter((e) => e.type === "PAYOUT"),
    ).toHaveLength(1);
    expect(balance.ledgerBalanceCents).toBe(0);
  });

  it("payoutDebit: rejects non-positive amounts", async () => {
    const { repo } = createHarness();

    await expect(
      repo.payoutDebit(buildPayoutDebitInput({ amountCents: 0 })),
    ).rejects.toThrow("payee_ledger_payout_debit_amount_must_be_positive");
  });

  it("markCreditsConsumed: stamps only unconsumed credits and returns the count", async () => {
    const { repo, entriesById } = createHarness();
    const creditA = await repo.settlementCredit(buildSettlementCreditInput());
    const creditB = await repo.settlementCredit(
      buildSettlementCreditInput({
        idempotencyKey: "settlement-credit:order_2:payee_1",
        orderId: "order_2",
        sourceId: "order_2",
        amountCents: 2_500,
      }),
    );
    const payout = await repo.payoutDebit(buildPayoutDebitInput());

    const first = await repo.markCreditsConsumed(
      [creditA.id, creditB.id],
      payout.id,
    );
    expect(first).toBe(2);
    expect(entriesById.get(creditA.id)?.consumedByEntryId).toBe(payout.id);
    expect(entriesById.get(creditB.id)?.consumedByEntryId).toBe(payout.id);

    // Already consumed: the NULL-guard refuses the second stamp even for a
    // REAL later payout of the same payee; the caller treats the 0 as a
    // fault.
    const laterPayout = await repo.payoutDebit(
      buildPayoutDebitInput({
        idempotencyKey: "payout:payout_item_2",
        sourceId: "payout_item_2",
      }),
    );
    const second = await repo.markCreditsConsumed([creditA.id], laterPayout.id);
    expect(second).toBe(0);
    expect(entriesById.get(creditA.id)?.consumedByEntryId).toBe(payout.id);
  });

  it("markCreditsConsumed: never stamps non-credit entries, and empty input is a no-op", async () => {
    const { repo, entriesById } = createHarness();
    const debit = await repo.refundDebit(buildRefundDebitInput());
    const payout = await repo.payoutDebit(buildPayoutDebitInput());

    expect(await repo.markCreditsConsumed([], payout.id)).toBe(0);
    expect(await repo.markCreditsConsumed([debit.id], payout.id)).toBe(0);
    expect(entriesById.get(debit.id)?.consumedByEntryId).toBeNull();
  });

  it("markCreditsConsumed: scoped by the payout entry — another payee's payout structurally cannot stamp these credits", async () => {
    const { repo, entriesById } = createHarness();
    const credit = await repo.settlementCredit(buildSettlementCreditInput());
    // A PAYOUT entry belonging to a DIFFERENT payee: the WHERE derives
    // payeeId/currency from the payout entry, so the credit falls out of
    // scope and the mismatch (0 ≠ 1) is the caller's fault signal.
    const foreignPayout = await repo.payoutDebit(
      buildPayoutDebitInput({
        idempotencyKey: "payout:payout_item_foreign",
        payeeId: "payee_2",
        sourceId: "payout_item_foreign",
      }),
    );

    expect(await repo.markCreditsConsumed([credit.id], foreignPayout.id)).toBe(0);
    expect(entriesById.get(credit.id)?.consumedByEntryId).toBeNull();

    // A payoutEntryId that names NO entry (or a non-PAYOUT entry) stamps
    // nothing either.
    expect(await repo.markCreditsConsumed([credit.id], "no_such_entry")).toBe(0);
    expect(await repo.markCreditsConsumed([credit.id], credit.id)).toBe(0);
    expect(entriesById.get(credit.id)?.consumedByEntryId).toBeNull();
  });

  it("sumReserveReleasedByPayoutItem: sums by the CARRYING item, absent when none", async () => {
    const { repo } = createHarness();
    const holdA = await repo.reserveHold(buildReserveHoldInput({ amountCents: 200 }));
    const holdB = await repo.reserveHold(
      buildReserveHoldInput({
        idempotencyKey: "reserve-hold:payout_item_1b",
        payoutItemId: "payout_item_1b",
        amountCents: 300,
      }),
    );
    await repo.reserveRelease({
      idempotencyKey: `reserve-release:${holdA.id}`,
      holdEntryId: holdA.id,
      payoutItemId: "payout_item_2",
    });
    await repo.reserveRelease({
      idempotencyKey: `reserve-release:${holdB.id}`,
      holdEntryId: holdB.id,
      payoutItemId: "payout_item_2",
    });

    const sums = await repo.sumReserveReleasedByPayoutItem([
      "payout_item_2",
      "payout_item_never_released",
    ]);

    expect(sums.get("payout_item_2")).toBe(500);
    expect(sums.has("payout_item_never_released")).toBe(false);
  });
});

function buildReverseDebitInput(
  overrides: Partial<ReturnType<typeof baseReverseDebitInput>> &
    Pick<ReturnType<typeof baseReverseDebitInput>, "debitEntryId">,
) {
  return { ...baseReverseDebitInput(), ...overrides };
}

function baseReverseDebitInput() {
  return {
    idempotencyKey: "dispute-debit-reversal:dispute_1:payee_1:usd",
    payeeId: "payee_1",
    amountCents: 6_500,
    currency: "USD",
    disputeId: "dispute_1",
    debitEntryId: "",
    orderId: "order_1",
    description: "Dispute debit reversed for order order_1 (dispute won)",
    metadata: { reversedIdempotencyKey: "dispute-debit:dispute_1:payee_1:usd" },
  };
}

function buildReserveHoldInput(
  overrides: Partial<ReturnType<typeof baseReserveHoldInput>> = {},
) {
  return { ...baseReserveHoldInput(), ...overrides };
}

function baseReserveHoldInput() {
  return {
    idempotencyKey: "reserve-hold:payout_item_1",
    payeeId: "payee_1",
    amountCents: 500,
    currency: "USD",
    payoutItemId: "payout_item_1",
    description: "Rolling reserve withheld from payout payout_1",
    metadata: { payoutId: "payout_1" },
  };
}

function buildSettlementCreditInput(
  overrides: Partial<ReturnType<typeof baseSettlementCreditInput>> = {},
) {
  return { ...baseSettlementCreditInput(), ...overrides };
}

function baseSettlementCreditInput() {
  return {
    idempotencyKey: "settlement-credit:order_1:payee_1",
    payeeId: "payee_1",
    amountCents: 10_000,
    currency: "USD",
    orderId: "order_1",
    availableAt: new Date("2026-06-01T00:00:00.000Z"),
    description: "Settlement credit for order order_1",
    metadata: { items: { item_1: 6_000, item_2: 4_000 } },
    sourceKind: "order_split",
    sourceId: "order_1",
  };
}

function buildRefundDebitInput(
  overrides: Partial<ReturnType<typeof baseRefundDebitInput>> = {},
) {
  return { ...baseRefundDebitInput(), ...overrides };
}

function baseRefundDebitInput() {
  return {
    idempotencyKey: "refund-debit:order_1:payee_1:refund_1",
    payeeId: "payee_1",
    amountCents: 4_000,
    currency: "USD",
    orderId: "order_1",
    description: "Refund debit for order order_1",
    sourceKind: "refund",
    sourceId: "refund_1",
    metadata: { refundId: "refund_1" },
  };
}

function buildTransferReversalCreditInput(
  overrides: Partial<ReturnType<typeof baseTransferReversalCreditInput>> &
    Pick<ReturnType<typeof baseTransferReversalCreditInput>, "relatedEntryId">,
) {
  return { ...baseTransferReversalCreditInput(), ...overrides };
}

function baseTransferReversalCreditInput() {
  return {
    idempotencyKey: "transfer-reversal-credit:refund_1:payee_1",
    payeeId: "payee_1",
    amountCents: 4_000,
    currency: "USD",
    orderId: "order_1",
    relatedEntryId: "",
    description: "Transfer reversal for refund refund_1",
  };
}

function buildPayoutDebitInput(
  overrides: Partial<ReturnType<typeof basePayoutDebitInput>> = {},
) {
  return { ...basePayoutDebitInput(), ...overrides };
}

function basePayoutDebitInput() {
  return {
    idempotencyKey: "payout:payout_item_1",
    payeeId: "payee_1",
    amountCents: 10_000,
    currency: "USD",
    sourceKind: "payout_item" as const,
    sourceId: "payout_item_1",
    description: "Payout transfer for payout item payout_item_1",
    metadata: { consumedCreditEntryIds: [] as string[] },
  };
}

function buildHoldInput(overrides: Partial<ReturnType<typeof baseHoldInput>> = {}) {
  return { ...baseHoldInput(), ...overrides };
}

function baseHoldInput() {
  return {
    idempotencyKey: "dispute-hold:dispute_1:payee_1:usd",
    payeeId: "payee_1",
    amountCents: 5_000,
    currency: "USD",
    disputeId: "dispute_1",
    orderId: "order_1",
    description: "Dispute hold for order order_1",
    metadata: { orderSplitIds: ["split_1"] },
  };
}

function buildDebitInput(
  overrides: Partial<ReturnType<typeof baseDebitInput>> = {},
) {
  return { ...baseDebitInput(), ...overrides };
}

function baseDebitInput() {
  return {
    idempotencyKey: "dispute-debit:dispute_1:payee_1:usd",
    payeeId: "payee_1",
    amountCents: 6_500,
    currency: "USD",
    disputeId: "dispute_1",
    orderId: "order_1",
    description: "Dispute debit for order order_1",
    metadata: { disputedAmountCents: 5_000, feeCents: 1_500 },
  };
}

function createHarness(options: HarnessOptions = {}) {
  const entriesById = new Map<string, PayeeLedgerEntry>();
  const entriesByKey = new Map<string, PayeeLedgerEntry>();
  const balances = new Map<string, PayeeLedgerBalance>();
  const executeRawCalls: ExecuteRawQuery[] = [];
  const queryRawCalls: Prisma.Sql[] = [];
  let nextEntryId = 1;
  let consumeHoldDuringNextReleaseCreate = options.consumeHoldDuringNextReleaseCreate;

  function insertEntry(data: EntryCreateManyArgs["data"]): PayeeLedgerEntry {
    const row: PayeeLedgerEntry = {
      id: `ledger_${nextEntryId++}`,
      idempotencyKey: data.idempotencyKey,
      payeeId: data.payeeId,
      type: data.type,
      amountCents: data.amountCents,
      currency: data.currency,
      sourceKind: data.sourceKind,
      sourceId: data.sourceId,
      orderId: data.orderId ?? null,
      settlementId: data.settlementId ?? null,
      disputeId: data.disputeId ?? null,
      relatedEntryId: data.relatedEntryId ?? null,
      availableAt: data.availableAt ?? null,
      consumedByEntryId: data.consumedByEntryId ?? null,
      description: data.description,
      metadata: null,
      createdAt: NOW,
    };
    entriesById.set(row.id, row);
    entriesByKey.set(row.idempotencyKey, row);
    return row;
  }

  function hasConsumedHold(relatedEntryId: string | null | undefined): boolean {
    if (!relatedEntryId) return false;
    return [...entriesById.values()].some(
      (entry) => entry.relatedEntryId === relatedEntryId && isReleaseType(entry.type),
    );
  }

  function applyConcurrentReleaseBalance(data: EntryCreateManyArgs["data"]): void {
    const key = balanceKey({ payeeId: data.payeeId, currency: data.currency });
    const existing = balances.get(key);
    if (!existing) return;
    balances.set(key, {
      ...existing,
      ledgerPendingHoldCents: Math.max(
        0,
        existing.ledgerPendingHoldCents - data.amountCents,
      ),
      updatedAt: NOW,
    });
  }

  const prisma = {
    payeeLedgerEntry: {
      findUnique: async (args: EntryFindUniqueArgs) => {
        if (args.where.idempotencyKey) {
          return entriesByKey.get(args.where.idempotencyKey) ?? null;
        }
        if (args.where.id) return entriesById.get(args.where.id) ?? null;
        return null;
      },
      createMany: async (args: EntryCreateManyArgs) => {
        if (entriesByKey.has(args.data.idempotencyKey)) return { count: 0 };
        if (consumeHoldDuringNextReleaseCreate && args.data.type === "DISPUTE_RELEASE") {
          consumeHoldDuringNextReleaseCreate = false;
          const winningRelease = {
            ...args.data,
            idempotencyKey: "release-key-that-won-race",
          };
          insertEntry(winningRelease);
          applyConcurrentReleaseBalance(winningRelease);
          return { count: 0 };
        }
        if (isConsumedHoldEntry(args.data) && hasConsumedHold(args.data.relatedEntryId)) {
          return { count: 0 };
        }
        insertEntry(args.data);
        return { count: 1 };
      },
      findMany: async (args: EntryFindManyArgs) => {
        let rows = [...entriesById.values()];
        const where = args.where ?? {};
        if (where.payeeId) {
          const filter = where.payeeId;
          rows = rows.filter((row) =>
            typeof filter === "string"
              ? row.payeeId === filter
              : filter.in.includes(row.payeeId),
          );
        }
        if (where.currency) rows = rows.filter((row) => row.currency === where.currency);
        if (where.orderId) rows = rows.filter((row) => row.orderId === where.orderId);
        if (where.disputeId) rows = rows.filter((row) => row.disputeId === where.disputeId);
        if (where.relatedEntryId) {
          rows = rows.filter((row) => row.relatedEntryId === where.relatedEntryId);
        }
        if (where.type) rows = rows.filter((row) => entryTypeMatches(row.type, where.type));
        // The snapshot bound and keyset, exactly as the adapter spells them:
        // `AND: [{ OR: [...] }, ...]`, each OR being `{ createdAt: { lt|gt } }`
        // or `{ createdAt: <equal>, id: { lte|gt } }`.
        for (const clause of where.AND ?? []) {
          rows = rows.filter((row) =>
            clause.OR.some((arm) => {
              const at = row.createdAt.getTime();
              if (arm.createdAt instanceof Date) {
                if (at !== arm.createdAt.getTime()) return false;
                if (arm.id?.lte !== undefined) return row.id <= arm.id.lte;
                if (arm.id?.gt !== undefined) return row.id > arm.id.gt;
                return true;
              }
              if (arm.createdAt?.lt) return at < arm.createdAt.lt.getTime();
              if (arm.createdAt?.gt) return at > arm.createdAt.gt.getTime();
              return false;
            }),
          );
        }
        const releasedTypes = where.relatedEntries?.none?.type?.in;
        if (releasedTypes) {
          rows = rows.filter(
            (row) =>
              ![...entriesById.values()].some(
                (related) =>
                  related.relatedEntryId === row.id && releasedTypes.includes(related.type),
              ),
          );
        }
        // Honour the ORDER BY as a key LIST, in order, so the `id` tie-break
        // the journal read relies on is actually exercised here.
        const orderKeys = Array.isArray(args.orderBy)
          ? args.orderBy
          : args.orderBy
            ? [args.orderBy]
            : [{ createdAt: "asc" as const }];
        rows.sort((left, right) => {
          for (const key of orderKeys) {
            if (key.createdAt) {
              const diff = left.createdAt.getTime() - right.createdAt.getTime();
              if (diff !== 0) return key.createdAt === "desc" ? -diff : diff;
            }
            if (key.id) {
              const diff = left.id.localeCompare(right.id);
              if (diff !== 0) return key.id === "desc" ? -diff : diff;
            }
          }
          return 0;
        });
        return rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? rows.length));
      },
      updateMany: async (args: EntryUpdateManyArgs) => {
        let count = 0;
        for (const row of entriesById.values()) {
          if (args.where.id && !args.where.id.in.includes(row.id)) continue;
          if (args.where.type && row.type !== args.where.type) continue;
          if (args.where.payeeId && row.payeeId !== args.where.payeeId) continue;
          if (args.where.currency && row.currency !== args.where.currency) {
            continue;
          }
          if (
            args.where.consumedByEntryId !== undefined &&
            row.consumedByEntryId !== args.where.consumedByEntryId
          ) {
            continue;
          }
          if (args.data.consumedByEntryId !== undefined) {
            const updated = {
              ...row,
              consumedByEntryId: args.data.consumedByEntryId,
            };
            entriesById.set(row.id, updated);
            entriesByKey.set(row.idempotencyKey, updated);
          }
          count += 1;
        }
        return { count };
      },
      groupBy: async (args: EntryGroupByArgs) => {
        let rows = [...entriesById.values()];
        const where = args.where ?? {};
        if (where.type) rows = rows.filter((row) => entryTypeMatches(row.type, where.type!));
        if (where.sourceId) {
          const filter = where.sourceId;
          rows = rows.filter((row) =>
            typeof filter === "string"
              ? row.sourceId === filter
              : filter.in.includes(row.sourceId),
          );
        }
        const groups = new Map<string, { sourceId: string; sum: number }>();
        for (const row of rows) {
          const existing = groups.get(row.sourceId);
          if (existing) existing.sum += row.amountCents;
          else groups.set(row.sourceId, { sourceId: row.sourceId, sum: row.amountCents });
        }
        return [...groups.values()].map((g) => ({
          sourceId: g.sourceId,
          _sum: { amountCents: g.sum },
        }));
      },
    },
    payeeLedgerBalance: {
      findUnique: async (args: BalanceFindUniqueArgs) => {
        return balances.get(balanceKey(args.where.payeeId_currency)) ?? null;
      },
      upsert: async (args: BalanceUpsertArgs) => {
        const key = balanceKey(args.where.payeeId_currency);
        const existing = balances.get(key);
        const row = existing
          ? updateBalance(existing, args.update)
          : createBalance(args.create);
        balances.set(key, row);
        return row;
      },
    },
    $executeRaw: async (query: ExecuteRawQuery) => {
      const [amountCents, payeeId, currency] = query.values;
      if (
        typeof amountCents !== "number" ||
        typeof payeeId !== "string" ||
        typeof currency !== "string"
      ) {
        throw new Error("unexpected_execute_raw_query");
      }
      executeRawCalls.push(query);
      const key = balanceKey({ payeeId, currency });
      const existing = balances.get(key);
      if (!existing) return 0;
      // Two GREATEST(0, …)-guarded decrements share this raw path; route on
      // the column named in the SQL text (the adapter's Prisma.sql template).
      const sqlText = (query.strings ?? []).join("");
      if (sqlText.includes("reserveBalanceCents")) {
        balances.set(key, {
          ...existing,
          reserveBalanceCents: Math.max(
            0,
            existing.reserveBalanceCents - amountCents,
          ),
          updatedAt: NOW,
        });
        return 1;
      }
      balances.set(key, {
        ...existing,
        ledgerPendingHoldCents: Math.max(
          0,
          existing.ledgerPendingHoldCents - amountCents,
        ),
        updatedAt: NOW,
      });
      return 1;
    },
    // Records the statement and returns nothing. Additive: before this key
    // existed, every $queryRaw path in the adapter threw here, so no existing
    // test can depend on its absence. It exists so a test can assert WHICH
    // path `listEntries` took — findMany (legacy) vs the filtered raw scan —
    // which is otherwise invisible from the outside.
    $queryRaw: async (query: unknown) => {
      queryRawCalls.push(query as Prisma.Sql);
      return [];
    },
  } as unknown as PrismaClientOrTx;

  return {
    repo: makePayeeLedgerRepo(prisma),
    entriesById,
    balances,
    executeRawCalls,
    queryRawCalls,
  };
}

type HarnessOptions = {
  consumeHoldDuringNextReleaseCreate?: boolean;
};

type EntryType = PayeeLedgerEntry["type"];
type EntryTypeFilter = EntryType | { in: readonly EntryType[] };

type EntryFindUniqueArgs = {
  where: { id?: string; idempotencyKey?: string };
};

type EntryCreateManyArgs = {
  data: {
    idempotencyKey: string;
    payeeId: string;
    type: EntryType;
    amountCents: number;
    currency: string;
    sourceKind: string;
    sourceId: string;
    orderId?: string | null;
    settlementId?: string | null;
    disputeId?: string | null;
    relatedEntryId?: string | null;
    availableAt?: Date | null;
    consumedByEntryId?: string | null;
    description: string;
    metadata?: unknown;
  };
  skipDuplicates: boolean;
};

type EntryUpdateManyArgs = {
  where: {
    id?: { in: readonly string[] };
    type?: EntryType;
    payeeId?: string;
    currency?: string;
    consumedByEntryId?: string | null;
  };
  data: { consumedByEntryId?: string | null };
};

type EntryFindManyArgs = {
  where?: {
    payeeId?: string | { in: readonly string[] };
    currency?: string;
    orderId?: string;
    disputeId?: string;
    relatedEntryId?: string;
    type?: EntryTypeFilter;
    relatedEntries?: {
      none?: { type?: { in: readonly EntryType[] } };
    };
    AND?: ReadonlyArray<{
      OR: ReadonlyArray<{
        createdAt?: Date | { lt?: Date; gt?: Date };
        id?: { lte?: string; gt?: string };
      }>;
    }>;
  };
  /**
   * Prisma accepts either form. The ARRAY form is what the journal read
   * (`listEntries`, plain path) uses so its `createdAt` DESC carries an `id`
   * DESC tie-break; modelling only the object form here made this fake sort
   * ASCENDING the moment the adapter switched, which is the sort of silent
   * drift a fake exists to avoid.
   */
  orderBy?:
    | { createdAt?: "asc" | "desc"; id?: "asc" | "desc" }
    | ReadonlyArray<{ createdAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
  take?: number;
  skip?: number;
};

type EntryGroupByArgs = {
  by: readonly string[];
  where?: {
    type?: EntryTypeFilter;
    sourceId?: string | { in: readonly string[] };
  };
  _sum?: { amountCents?: boolean };
};

type BalanceWhere = { payeeId: string; currency: string };
type NumberUpdate = number | { increment: number };

type BalanceFindUniqueArgs = {
  where: { payeeId_currency: BalanceWhere };
};

type BalanceCreateData = {
  payeeId: string;
  currency: string;
  ledgerBalanceCents: number;
  ledgerPendingHoldCents: number;
  reserveBalanceCents: number;
};

type BalanceUpdateData = {
  ledgerBalanceCents?: NumberUpdate;
  ledgerPendingHoldCents?: NumberUpdate;
  reserveBalanceCents?: NumberUpdate;
};

type BalanceUpsertArgs = {
  where: { payeeId_currency: BalanceWhere };
  create: BalanceCreateData;
  update: BalanceUpdateData;
};

type ExecuteRawQuery = {
  values: unknown[];
  /** Prisma.Sql template segments — used to route the two raw decrements. */
  strings?: readonly string[];
};

function entryTypeMatches(type: EntryType, filter: EntryTypeFilter): boolean {
  if (typeof filter === "string") return type === filter;
  return filter.in.includes(type);
}

function isConsumedHoldEntry(data: EntryCreateManyArgs["data"]): boolean {
  return (
    data.relatedEntryId !== null &&
    data.relatedEntryId !== undefined &&
    isReleaseType(data.type)
  );
}

function isReleaseType(type: EntryType): boolean {
  return type === "DISPUTE_RELEASE" || type === "DISPUTE_DEBIT";
}

function balanceKey(where: BalanceWhere): string {
  return `${where.payeeId}:${where.currency}`;
}

function createBalance(data: BalanceCreateData): PayeeLedgerBalance {
  return { ...data, updatedAt: NOW };
}

function updateBalance(
  row: PayeeLedgerBalance,
  update: BalanceUpdateData,
): PayeeLedgerBalance {
  return {
    ...row,
    ledgerBalanceCents: applyNumberUpdate(
      row.ledgerBalanceCents,
      update.ledgerBalanceCents,
    ),
    ledgerPendingHoldCents: applyNumberUpdate(
      row.ledgerPendingHoldCents,
      update.ledgerPendingHoldCents,
    ),
    reserveBalanceCents: applyNumberUpdate(
      row.reserveBalanceCents,
      update.reserveBalanceCents,
    ),
    updatedAt: NOW,
  };
}

function applyNumberUpdate(current: number, update: NumberUpdate | undefined): number {
  if (update === undefined) return current;
  if (typeof update === "number") return update;
  return current + update.increment;
}
describe("buildUpcomingMaturitiesSql — payee narrowing", () => {
  // The organiser payouts view is THIS statement narrowed to one payee, never
  // a second implementation of the forecast. The rows are an integration
  // concern; these assertions cover what an integration test on a UTC box
  // cannot make obvious — that the narrowing is BOUND, and that it lands
  // INSIDE the credit CTE rather than after the aggregate.
  const AS_OF = new Date("2026-09-16T00:00:00.000Z");

  it("emits no payee predicate at all when payeeIds is omitted — every payee", () => {
    const sql = buildUpcomingMaturitiesSql({ asOf: AS_OF });

    expect(sql.text).not.toContain('e."payeeId" = ANY');
    // `asOf` is the first bound value; the trailing one is the shared
    // hold-not-consumed fragment's release-type array, which is present
    // either way. The point is that NO payee-id array joins them.
    expect(sql.values[0]).toEqual(AS_OF);
    expect(
      sql.values.filter((v) => Array.isArray(v) && v.every((x) => typeof x === "string")),
    ).toEqual([["DISPUTE_RELEASE", "DISPUTE_DEBIT"]]);
  });

  it("binds the payee ids as a text[] parameter, never interpolated", () => {
    const sql = buildUpcomingMaturitiesSql({
      asOf: AS_OF,
      payeeIds: ["payee_1", "payee_2"],
    });

    expect(sql.text).toContain('AND e."payeeId" = ANY($');
    expect(sql.text).toContain("::text[]");
    expect(sql.values).toContainEqual(["payee_1", "payee_2"]);
    expect(sql.text).not.toContain("payee_1");
  });

  it("an EXPLICIT empty array still emits the predicate — no payees, no rows", () => {
    // Coalescing `[]` to "no filter" would show one organiser the whole
    // platform's forecast. The predicate must survive; Postgres reads
    // `= ANY('{}')` as false for every row.
    const sql = buildUpcomingMaturitiesSql({ asOf: AS_OF, payeeIds: [] });

    expect(sql.text).toContain('e."payeeId" = ANY($');
    expect(sql.values).toContainEqual([]);
  });

  it("narrows INSIDE tranche_credits, before the aggregate — not after it", () => {
    // A bounded index scan is the whole reason the argument exists. If the
    // predicate drifted below the GROUP BY (or into a wrapper around
    // `tranches`), the statement would still return the right rows while
    // costing a full-ledger aggregate — correct and useless, and no
    // row-level assertion would ever catch it.
    const sql = buildUpcomingMaturitiesSql({ asOf: AS_OF, payeeIds: ["payee_1"] });

    const filterAt = sql.text.indexOf('e."payeeId" = ANY');
    const groupAt = sql.text.indexOf("GROUP BY");
    expect(filterAt).toBeGreaterThan(-1);
    expect(groupAt).toBeGreaterThan(filterAt);
    // And it is bound to the credit alias `e` inside tranche_credits, not to
    // the tranche alias `tr` that the outer SELECT reads.
    expect(sql.text).not.toContain('tr."payeeId" = ANY');
  });

  it("keeps the shared blocked-credit fragment — a narrowed forecast is the same forecast", () => {
    const wide = buildUpcomingMaturitiesSql({ asOf: AS_OF });
    const narrow = buildUpcomingMaturitiesSql({
      asOf: AS_OF,
      payeeIds: ["payee_1"],
    });

    // The narrowed statement must differ from the full-ledger one by EXACTLY
    // the payee predicate. Anything else means the two surfaces can disagree
    // about a tranche in front of a customer.
    expect(narrow.text.replace(/AND e\."payeeId" = ANY\(\$\d+::text\[\]\)/, "")).toBe(
      wide.text.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + 1}`),
    );
  });
});

describe("listEntries — attribution options", () => {
  const AS_OF = new Date("2026-09-16T00:00:00.000Z");

  it("takes the legacy findMany path when NO attribution option is passed", async () => {
    const h = createHarness();
    await h.repo.listEntries("payee_1", { currency: "USD", limit: 10 });

    // Byte-for-byte the read it always was: no raw statement at all.
    expect(h.queryRawCalls).toHaveLength(0);
  });

  it.each([
    ["availableAtAfter", { availableAtAfter: AS_OF }],
    ["availableAtBefore", { availableAtBefore: AS_OF }],
    ["unconsumedOnly", { unconsumedOnly: true }],
    ["excludeBlockedCredits", { excludeBlockedCredits: true }],
  ])("takes the raw scan when %s is passed", async (_name, opts) => {
    const h = createHarness();
    await h.repo.listEntries("payee_1", opts);

    expect(h.queryRawCalls).toHaveLength(1);
    expect(h.queryRawCalls[0]!.values).toContain("payee_1");
  });

  // ── The journal read's ORDER, which the organiser statement pages ────────
  // `createdAt` alone is NOT a total order: one order's credits are written
  // in a single transaction and routinely share a timestamp. Under OFFSET
  // paging, tied rows in an unspecified order silently repeat one row and
  // drop another. Every entry in this harness carries the SAME `createdAt`,
  // so these two assertions fail the moment the tie-break is dropped.
  it("breaks createdAt ties by id DESC, matching the filtered path's ORDER BY", async () => {
    const h = createHarness();
    for (const n of [1, 2, 3]) {
      await h.repo.settlementCredit(
        buildSettlementCreditInput({
          idempotencyKey: `settlement-credit:order_${n}:payee_1`,
          orderId: `order_${n}`,
          sourceId: `order_${n}`,
        }),
      );
    }

    const rows = await h.repo.listEntries("payee_1", { limit: 10 });

    expect(rows.map((r) => r.id)).toEqual(["ledger_3", "ledger_2", "ledger_1"]);
  });

  it("pages tied rows with no row repeated and none dropped", async () => {
    const h = createHarness();
    for (const n of [1, 2, 3]) {
      await h.repo.settlementCredit(
        buildSettlementCreditInput({
          idempotencyKey: `settlement-credit:order_${n}:payee_1`,
          orderId: `order_${n}`,
          sourceId: `order_${n}`,
        }),
      );
    }

    const first = await h.repo.listEntries("payee_1", { limit: 2, offset: 0 });
    const second = await h.repo.listEntries("payee_1", { limit: 2, offset: 2 });
    const seen = [...first, ...second].map((r) => r.id);

    expect(seen).toEqual(["ledger_3", "ledger_2", "ledger_1"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  // ── The export's snapshot walk (`atOrBefore` + `order`) ──────────────────
  // Neither option is an attribution option, so both stay on the findMany
  // path; the row-level proof on real Postgres, for both paths, is in
  // payee-ledger-payable.integration.test.ts.
  it("keeps atOrBefore and order on the findMany path, bounded and reversed", async () => {
    const h = createHarness();
    for (const n of [1, 2, 3]) {
      await h.repo.settlementCredit(
        buildSettlementCreditInput({
          idempotencyKey: `settlement-credit:order_${n}:payee_1`,
          orderId: `order_${n}`,
          sourceId: `order_${n}`,
        }),
      );
    }
    // Every harness row shares one createdAt, so the id half of the cursor
    // is what bounds the read here.
    const cursorAt = h.entriesById.get("ledger_2")!.createdAt;

    const rows = await h.repo.listEntries("payee_1", {
      atOrBefore: { createdAt: cursorAt, id: "ledger_2" },
      order: "asc",
      limit: 10,
    });

    expect(h.queryRawCalls).toHaveLength(0);
    expect(rows.map((r) => r.id)).toEqual(["ledger_1", "ledger_2"]);
  });

  it("keyset `after` is EXCLUSIVE, stays on findMany, and composes with atOrBefore", async () => {
    const h = createHarness();
    for (const n of [1, 2, 3, 4]) {
      await h.repo.settlementCredit(
        buildSettlementCreditInput({
          idempotencyKey: `settlement-credit:order_${n}:payee_1`,
          orderId: `order_${n}`,
          sourceId: `order_${n}`,
        }),
      );
    }
    const at = h.entriesById.get("ledger_1")!.createdAt;

    const afterOnly = await h.repo.listEntries("payee_1", {
      after: { createdAt: at, id: "ledger_1" },
      order: "asc",
      limit: 10,
    });
    expect(afterOnly.map((r) => r.id)).toEqual(["ledger_2", "ledger_3", "ledger_4"]);

    const window = await h.repo.listEntries("payee_1", {
      atOrBefore: { createdAt: at, id: "ledger_3" },
      after: { createdAt: at, id: "ledger_1" },
      order: "asc",
      limit: 10,
    });
    expect(window.map((r) => r.id)).toEqual(["ledger_2", "ledger_3"]);
    expect(h.queryRawCalls).toHaveLength(0);
  });

  it("does NOT take the raw scan for an explicitly false boolean option", async () => {
    const h = createHarness();
    await h.repo.listEntries("payee_1", {
      unconsumedOnly: false,
      excludeBlockedCredits: false,
    });

    expect(h.queryRawCalls).toHaveLength(0);
  });
});

describe("buildFilteredEntriesSql", () => {
  const AS_OF = new Date("2026-09-16T00:00:00.000Z");

  it("emits only the payee predicate when no attribution option is set", () => {
    const sql = buildFilteredEntriesSql({ payeeId: "payee_1", opts: {} });

    expect(sql.text).toContain('WHERE e."payeeId" = $1');
    // The PREDICATES only: the SELECT list carries the effective-maturity
    // column (which reads availableAt and has its own sub-select), but no
    // filter may be emitted without an option asking for it.
    const where = sql.text.slice(sql.text.indexOf('WHERE e."payeeId" = $1'));
    expect(where).not.toContain('e."availableAt"');
    expect(where).not.toContain('e."consumedByEntryId" IS NULL');
    expect(where).not.toContain("NOT EXISTS");
    expect(sql.text).toContain(
      `SELECT e.*, ${CREDIT_EFFECTIVE_MATURITY_SQL.text} AS "effectiveAvailableAt"`,
    );
    // payeeId, limit, offset — the defaults are BOUND, not interpolated.
    expect(sql.values).toEqual(["payee_1", 50, 0]);
  });

  it("matches listUpcomingMaturities' maturity bound EXACTLY — strictly after", () => {
    // `>` not `>=`. listUpcomingMaturities uses `availableAt > asOf`, so a
    // credit maturing ON the instant belongs to no tranche. Including it here
    // would make the sub-lines out-sum the heading they sit under, which is
    // the entire failure this option was added to prevent.
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { availableAtAfter: AS_OF },
    });

    // On the EFFECTIVE maturity (the date the forecast buckets under), still
    // strictly after.
    expect(sql.text).toContain(`AND ${CREDIT_EFFECTIVE_MATURITY_SQL.text} > $`);
    expect(sql.text).not.toContain(`${CREDIT_EFFECTIVE_MATURITY_SQL.text} >= `);
    expect(sql.text).not.toContain('e."availableAt" >= ');
    expect(sql.values).toContainEqual(AS_OF);
  });

  it("bounds the far end INCLUSIVELY, so the last visible tranche's rows are in", () => {
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { availableAtBefore: AS_OF },
    });

    expect(sql.text).toContain(`AND ${CREDIT_EFFECTIVE_MATURITY_SQL.text} <= $`);
  });

  it("reuses the SHARED blocked-credit fragment, and only against credits", () => {
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { excludeBlockedCredits: true },
    });

    // The distinguishing bytes of CREDIT_NOT_BLOCKED_SQL. A retyped
    // predicate is the drift this assertion exists to catch: if it ever
    // stops being the shared fragment, the attribution rows stop agreeing
    // with the tranche totals.
    expect(sql.text).toContain(`o."disputeStatus" IN ('OPEN', 'UNDER_REVIEW')`);
    expect(sql.text).toContain(`cl."status" IN ('open', 'under_review')`);
    expect(sql.text).toContain(`r."type" IN ('DISPUTE_RELEASE', 'DISPUTE_DEBIT')`);
    // Guarded by a type disjunction — nothing blocks a debit, and a bare
    // predicate would have silently dropped every non-credit row.
    expect(sql.text).toContain(`AND (e."type" <> 'SETTLEMENT_CREDIT' OR`);
  });

  it("composes every filter into one WHERE, all values bound", () => {
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: {
        currency: " USD ",
        types: ["SETTLEMENT_CREDIT"],
        availableAtAfter: AS_OF,
        unconsumedOnly: true,
        excludeBlockedCredits: true,
        limit: 25,
        offset: 5,
      },
    });

    expect(sql.text.match(/WHERE e\."payeeId"/g)).toHaveLength(1);
    // Currency is normalised on the COLUMN, the same spelling
    // buildUpcomingMaturitiesSql groups on — so a row stored 'USD' that the
    // tranche total counted is also LISTED here, rather than counted above
    // and missing below.
    expect(sql.text).toContain('btrim(lower(e."currency")) = $');
    expect(sql.values).toContain("usd");
    expect(sql.values).toContainEqual(["SETTLEMENT_CREDIT"]);
    expect(sql.values).toContain(25);
    expect(sql.values).toContain(5);
    expect(sql.values.some((v) => typeof v === "string" && v.includes("USD"))).toBe(
      false,
    );
  });

  it("agrees with the tranche read on currency casing, by construction", () => {
    // The tranche read groups on btrim(lower(currency)), so `tranche.currency`
    // is always lowercase. If this path compared the RAW column, a row stored
    // 'USD' would be inside the tranche total and absent from the list under
    // it — heading and sub-lines disagreeing over casing alone.
    const maturities = buildUpcomingMaturitiesSql({ asOf: AS_OF });
    const entries = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { currency: "usd", availableAtAfter: AS_OF },
    });

    expect(maturities.text).toContain('btrim(lower(e."currency"))');
    expect(entries.text).toContain('btrim(lower(e."currency")) = $');
    expect(entries.text).not.toContain('AND e."currency" = $');
  });

  it("clamps limit and offset to non-negative integers", () => {
    // Prisma's findMany accepts take: -5 (backwards pagination); Postgres
    // rejects `LIMIT -5` outright. Unclamped, the two branches of listEntries
    // answer the same input with a page and an exception.
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { unconsumedOnly: true, limit: -5, offset: -3 },
    });

    expect(sql.values).toContain(0);
    expect(sql.values.some((v) => typeof v === "number" && v < 0)).toBe(false);

    const fractional = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { unconsumedOnly: true, limit: 10.7, offset: 2.9 },
    });
    expect(fractional.values).toContain(10);
    expect(fractional.values).toContain(2);
  });

  it("orders deterministically — createdAt DESC with an id tiebreak", () => {
    // This path is OFFSET-paged. An unstable sort under OFFSET drops rows
    // from one page and repeats them on the next, and the symptom looks like
    // a money bug rather than a sort bug.
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { unconsumedOnly: true },
    });

    expect(sql.text).toContain('ORDER BY e."createdAt" DESC, e."id" DESC');
  });

  it("adds no snapshot predicate unless asked, and binds the cursor when it is", () => {
    const plain = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { unconsumedOnly: true },
    });
    expect(plain.text).not.toContain('(e."createdAt", e."id") <=');

    const cursorAt = new Date("2026-09-15T00:00:00.000Z");
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: {
        unconsumedOnly: true,
        atOrBefore: { createdAt: cursorAt, id: "ledger_9" },
        order: "asc",
      },
    });
    // A row-value comparison, inclusive, both halves BOUND.
    expect(sql.text).toMatch(/AND \(e\."createdAt", e\."id"\) <= \(\$\d+, \$\d+\)/);
    expect(sql.values).toContainEqual(cursorAt);
    expect(sql.values).toContain("ledger_9");
    expect(sql.text).toContain('ORDER BY e."createdAt" ASC, e."id" ASC');
  });

  it("emits the keyset `after` as an EXCLUSIVE bound row-value comparison, beside atOrBefore", () => {
    const plain = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: { unconsumedOnly: true },
    });
    expect(plain.text).not.toContain('(e."createdAt", e."id") >');

    const upper = new Date("2026-09-15T00:00:00.000Z");
    const lower = new Date("2026-09-01T00:00:00.000Z");
    const sql = buildFilteredEntriesSql({
      payeeId: "payee_1",
      opts: {
        unconsumedOnly: true,
        atOrBefore: { createdAt: upper, id: "ledger_9" },
        after: { createdAt: lower, id: "ledger_2" },
        order: "asc",
      },
    });
    expect(sql.text).toMatch(/AND \(e\."createdAt", e\."id"\) > \(\$\d+, \$\d+\)/);
    expect(sql.text).not.toMatch(/\(e\."createdAt", e\."id"\) >= /);
    expect(sql.text).toMatch(/AND \(e\."createdAt", e\."id"\) <= \(\$\d+, \$\d+\)/);
    expect(sql.values).toContainEqual(lower);
    expect(sql.values).toContain("ledger_2");
    // The availableAt filter's name is not reused: no maturity bound appears.
    expect(sql.text).not.toContain(`${CREDIT_EFFECTIVE_MATURITY_SQL.text} > $`);
  });
});

describe("payable credit gates — resale claim freeze and claim window", () => {
  // The rows are the integration suite's concern
  // (payee-ledger-payable.integration.test.ts). These pin the SHAPE that a
  // reviewer cannot see from a green integration run on a happy fixture.

  it("an APPROVED claim blocks the credit until the order is REFUNDED", () => {
    const text = CREDIT_NOT_BLOCKED_SQL.text.replace(/\s+/g, " ");
    expect(text).toContain(`cl."status" IN ('open', 'under_review')`);
    expect(text).toContain(`cla."status" = 'approved'`);
    // Claim tests correlate on orderId ALONE (hashable once per query); the
    // three-column covering check sits behind the CASE.
    expect(text).toMatch(/CASE WHEN EXISTS \( SELECT 1 FROM public\."Claim" cla WHERE cla\."orderId" = e\."orderId"/);
    expect(text).toContain(`clo."status" = 'REFUNDED'`);
    // …and never stacks with a debit or ACTIVE hold on the same cell.
    expect(text).toContain(`cx."type" = 'REFUND_DEBIT'`);
    expect(text).toContain(`cx."type" = 'DISPUTE_DEBIT' AND cx."idempotencyKey" NOT LIKE 'dispute-debit-fee:%'`);
    expect(text).toContain(`cx."type" = 'DISPUTE_HOLD' AND NOT EXISTS`);
    // A REVERSED principal debit (WON after LOST) does not cover.
    expect(text).toContain(`cxr2."relatedEntryId" = cx."id" AND cxr2."type" = 'DISPUTE_RELEASE'`);
    // The hold arm's release list is RELEASE_TYPES, inlined (still bind-free).
    expect(text).toContain(`cxr."type" IN ('DISPUTE_RELEASE', 'DISPUTE_DEBIT')`);
    expect(text).toContain(`cx."payeeId" = e."payeeId" AND cx."currency" = e."currency"`);
    // Still a constant fragment: nothing bound (callers' value positions
    // depend on it).
    expect(CREDIT_NOT_BLOCKED_SQL.values).toEqual([]);
  });

  it("an OPEN / UNDER_REVIEW claim blocks the credit with no time bound (past the window close)", () => {
    // Owner ruling Q9 (2026-10-06): no claim is closed automatically, so the
    // open-claim arm must hold the credit until staff decide — independent of
    // the claim deadline, the window close and asOf. Pin that the arm reads
    // only the claim's order and status.
    const text = CREDIT_NOT_BLOCKED_SQL.text.replace(/\s+/g, " ");
    const arm = text.match(
      /AND NOT EXISTS \( SELECT 1 FROM public\."Claim" cl WHERE (.*?) \)/,
    );
    expect(arm?.[1]).toBe(
      `cl."orderId" = e."orderId" AND cl."status" IN ('open', 'under_review')`,
    );
    expect(text).not.toMatch(/deadline/i);
    // The block is ANDed beside maturity, not folded into it: the forecast
    // also excludes a blocked credit, so a claim held past the close is in
    // neither payable nor forecast until staff decide.
    const forecast = buildUpcomingMaturitiesSql({ asOf: NOW });
    expect(forecast.text).toContain(CREDIT_NOT_BLOCKED_SQL.text);
  });

  it("maturity = GREATEST(availableAt, claim close from the event's CURRENT end) for RESALE", () => {
    const text = CREDIT_EFFECTIVE_MATURITY_SQL.text.replace(/\s+/g, " ");
    expect(text).toContain(`WHEN e."availableAt" IS NULL THEN NULL`);
    expect(text).toContain(`GREATEST( e."availableAt",`);
    expect(text).toContain(`rso."source" = 'RESALE'`);
    expect(text).toContain(`COALESCE(rwe."endsAt", rwe."startsAt")`);
    // The window is the @th/types constant, inlined as a literal: the
    // fragment stays bind-free so it never shifts callers' bind positions.
    expect(text).toContain(`make_interval(days => ${RESALE_CLAIM_WINDOW_DAYS})`);
    expect(CREDIT_EFFECTIVE_MATURITY_SQL.values).toEqual([]);

    // Half-open: mature AT the close (create-claim refuses then).
    const asOf = new Date("2026-06-15T00:00:00.000Z");
    const matured = creditMaturedSql(asOf);
    expect(matured.text).toContain(`${CREDIT_EFFECTIVE_MATURITY_SQL.text} <= $1`);
    expect(matured.values).toEqual([asOf]);
  });

  it("payable, forecast and tranche feed all mature on the SAME expression", () => {
    const eff = CREDIT_EFFECTIVE_MATURITY_SQL.text;
    const forecast = buildUpcomingMaturitiesSql({ asOf: NOW });
    expect(forecast.text).toContain(`${eff} AS "effectiveMaturesAt"`);
    expect(forecast.text).toContain(`e."effectiveMaturesAt" > $`);
    expect(forecast.text).not.toContain(`e."availableAt" > $`);
    // Still asOf-first in the bound values (the payee-narrowing pins above).
    expect(forecast.values[0]).toEqual(NOW);
  });

  it("binds the SAME window core uses for the claim deadline", () => {
    const end = new Date("2026-06-01T23:00:00.000Z");
    const coreClose = resaleClaimWindowClosesAt({ startsAt: end, endsAt: end });
    expect(RESALE_CLAIM_WINDOW_DAYS).toBe(3);
    expect(coreClose.getTime() - end.getTime()).toBe(
      RESALE_CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});
