import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";

import type { ChargeRefunded } from "../guards";
import { onChargeRefunded } from "../handlers/charge-refunded";

function makeLogger(): LoggerPort {
  return {
    child: vi.fn(() => makeLogger()),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeCharge(overrides: Partial<ChargeRefunded> = {}): ChargeRefunded {
  return {
    id: "ch_123",
    object: "charge",
    refunded: true,
    payment_intent: "pi_123",
    amount_refunded: 11000,
    ...overrides,
  };
}

describe("onChargeRefunded", () => {
  it("calls the reconciliation path for full refunds", async () => {
    const logger = makeLogger();
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "reconciled_primary" as const,
    }));

    await onChargeRefunded({ logger, reconcileStripeFullRefund }, makeCharge());

    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 11000,
      sourceEventType: "charge.refunded",
      fullyRefundedHint: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "onChargeRefunded",
      expect.objectContaining({ reconcileOutcome: "reconciled_primary" }),
    );
  });

  it("resolves the refund id for FULL refunds too, so internal `re_…`-keyed debits dedupe", async () => {
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "reconciled_primary" as const,
    }));

    await onChargeRefunded(
      { reconcileStripeFullRefund },
      makeCharge({ refunds: { data: [{ id: "re_full" }] } }),
    );

    // A resolvable id makes the full arm's debit key collide with the
    // internal refund path (cancel-event et al.) that keyed on the same
    // Stripe refund id — repo-level dedupe then survives most orderings of
    // the cancel × reconcile race.
    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 11000,
      refundId: "re_full",
      sourceEventType: "charge.refunded",
      fullyRefundedHint: true,
    });
  });

  it("fetches the refund id for FULL refunds when the payload omits the list, and falls back to no id", async () => {
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "reconciled_primary" as const,
    }));
    const getLatestRefundId = vi.fn(async () => "re_fetched_full");

    await onChargeRefunded(
      { reconcileStripeFullRefund, getLatestRefundId },
      makeCharge(),
    );
    expect(reconcileStripeFullRefund).toHaveBeenLastCalledWith(
      expect.objectContaining({ refundId: "re_fetched_full" }),
    );

    // Resolution failure → the historical no-refundId input, byte-identical
    // to the pre-change shape (the use case's `pi:{pi}:{amount}` fallback
    // key MUST survive the deploy boundary for rows already written).
    getLatestRefundId.mockResolvedValueOnce(undefined);
    await onChargeRefunded(
      { reconcileStripeFullRefund, getLatestRefundId },
      makeCharge(),
    );
    expect(reconcileStripeFullRefund).toHaveBeenLastCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 11000,
      sourceEventType: "charge.refunded",
      fullyRefundedHint: true,
    });
  });

  it("reconciles partial refunds with the embedded refund id", async () => {
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "partial_refund_reconciled" as const,
    }));
    const getLatestRefundId = vi.fn();

    await onChargeRefunded(
      { reconcileStripeFullRefund, getLatestRefundId },
      makeCharge({
        refunded: false,
        amount_refunded: 5000,
        refunds: { data: [{ id: "re_partial" }] },
      }),
    );

    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 5000,
      refundId: "re_partial",
      sourceEventType: "charge.refunded",
      fullyRefundedHint: false,
    });
    // Embedded id present → no API round-trip.
    expect(getLatestRefundId).not.toHaveBeenCalled();
  });

  it("fetches the latest refund id for partials when the payload omits the refund list", async () => {
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "partial_refund_reconciled" as const,
    }));
    const getLatestRefundId = vi.fn(async () => "re_fetched");

    await onChargeRefunded(
      { reconcileStripeFullRefund, getLatestRefundId },
      makeCharge({ refunded: false, amount_refunded: 5000 }),
    );

    expect(getLatestRefundId).toHaveBeenCalledWith({ chargeId: "ch_123" });
    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 5000,
      refundId: "re_fetched",
      sourceEventType: "charge.refunded",
      fullyRefundedHint: false,
    });
  });

  it("still reconciles a partial without any refund id — the use case reports and skips", async () => {
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_123",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "partial_refund_ignored" as const,
    }));

    await onChargeRefunded(
      { reconcileStripeFullRefund },
      makeCharge({ refunded: false, amount_refunded: 5000 }),
    );

    // No embedded list, no fetcher: the call is still made so the use
    // case's missing-refund-id report fires (visibility, never silence).
    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_123",
      amountRefundedCents: 5000,
      sourceEventType: "charge.refunded",
      fullyRefundedHint: false,
    });
  });

  it("does not call reconciliation when the payment intent is missing", async () => {
    const reconcileStripeFullRefund = vi.fn();

    await onChargeRefunded(
      { reconcileStripeFullRefund },
      makeCharge({ payment_intent: null }),
    );

    expect(reconcileStripeFullRefund).not.toHaveBeenCalled();
  });
});
