import { describe, it, expect, vi } from "vitest";
import { onRefundUpdated } from "../handlers/refund-updated";
import type { RefundUpdated } from "../guards";
import type { LoggerPort } from "@th/ports/logger";
import type { AuditRepo } from "@th/ports/repos/audit";

function makeLogger(): LoggerPort {
  return {
    child: vi.fn(() => makeLogger()),
    withTime: vi.fn(async (_name, f) => f()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeAudit(): AuditRepo & { log: ReturnType<typeof vi.fn> } {
  return { log: vi.fn(async () => {}) };
}

function baseRefund(overrides: Partial<RefundUpdated> = {}): RefundUpdated {
  return {
    id: "re_test_123",
    object: "refund",
    status: "succeeded",
    amount: 5000,
    currency: "usd",
    charge: "ch_abc",
    payment_intent: "pi_xyz",
    failure_reason: null,
    reason: null,
    ...overrides,
  };
}

describe("onRefundUpdated", () => {
  it("logs at info level when refund succeeds", async () => {
    const logger = makeLogger();
    const audit = makeAudit();
    const getChargeRefundState = vi.fn(async () => ({
      amountRefundedCents: 11000,
      fullyRefunded: true,
    }));
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_xyz",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "reconciled_primary" as const,
    }));

    await onRefundUpdated(
      { logger, audit, getChargeRefundState, reconcileStripeFullRefund },
      baseRefund({ status: "succeeded" }),
    );

    expect(getChargeRefundState).toHaveBeenCalledWith({ chargeId: "ch_abc" });
    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_xyz",
      amountRefundedCents: 11000,
      currency: "usd",
      refundId: "re_test_123",
      sourceEventType: "charge.refund.updated",
      fullyRefundedHint: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      "onRefundUpdated.refund_confirmed",
      expect.objectContaining({
        refundId: "re_test_123",
        reconcileOutcome: "reconciled_primary",
      }),
    );
    expect(logger.error).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("logs error AND writes audit log when refund fails", async () => {
    const logger = makeLogger();
    const audit = makeAudit();

    await onRefundUpdated(
      { logger, audit },
      baseRefund({
        status: "failed",
        failure_reason: "expired_or_canceled_card",
      }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      "onRefundUpdated.REFUND_FAILED",
      expect.objectContaining({
        refundId: "re_test_123",
        chargeId: "ch_abc",
        paymentIntentId: "pi_xyz",
        amountCents: 5000,
        failureReason: "expired_or_canceled_card",
      }),
    );

    expect(audit.log).toHaveBeenCalledWith({
      entity: "refund_anomaly",
      entityId: "re_test_123",
      action: "async_refund_failed",
      data: expect.objectContaining({
        chargeId: "ch_abc",
        paymentIntentId: "pi_xyz",
        amountCents: 5000,
        currency: "usd",
        failureReason: "expired_or_canceled_card",
      }),
    });
  });

  it("defaults failure_reason to 'unknown' when null", async () => {
    const logger = makeLogger();
    const audit = makeAudit();

    await onRefundUpdated(
      { logger, audit },
      baseRefund({ status: "failed", failure_reason: null }),
    );

    expect(logger.error).toHaveBeenCalledWith(
      "onRefundUpdated.REFUND_FAILED",
      expect.objectContaining({ failureReason: "unknown" }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureReason: "unknown" }),
      }),
    );
  });

  it("handles missing audit dep gracefully (log-only)", async () => {
    const logger = makeLogger();
    const reconcileStripeFullRefund = vi.fn();

    // No audit port — should not throw
    await onRefundUpdated(
      { logger, reconcileStripeFullRefund },
      baseRefund({ status: "failed" }),
    );

    expect(reconcileStripeFullRefund).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "onRefundUpdated.REFUND_FAILED",
      expect.objectContaining({ refundId: "re_test_123" }),
    );
  });

  it("logs at info level for pending/requires_action/canceled statuses", async () => {
    const logger = makeLogger();
    const reconcileStripeFullRefund = vi.fn();

    for (const status of ["pending", "requires_action", "canceled"] as const) {
      await onRefundUpdated(
        { logger, reconcileStripeFullRefund },
        baseRefund({ status }),
      );
    }

    expect(reconcileStripeFullRefund).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not reconcile succeeded refunds without a payment intent", async () => {
    const logger = makeLogger();
    const getChargeRefundState = vi.fn();
    const reconcileStripeFullRefund = vi.fn();

    await onRefundUpdated(
      { logger, getChargeRefundState, reconcileStripeFullRefund },
      baseRefund({ status: "succeeded", payment_intent: null }),
    );

    expect(getChargeRefundState).not.toHaveBeenCalled();
    expect(reconcileStripeFullRefund).not.toHaveBeenCalled();
  });

  it("uses cumulative charge refund state for a final partial chunk", async () => {
    const logger = makeLogger();
    const getChargeRefundState = vi.fn(async () => ({
      amountRefundedCents: 11000,
      fullyRefunded: true,
    }));
    const reconcileStripeFullRefund = vi.fn(async () => ({
      ok: true as const,
      paymentIntentId: "pi_xyz",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderSource: "PRIMARY" as const,
      outcome: "reconciled_primary" as const,
    }));

    await onRefundUpdated(
      { logger, getChargeRefundState, reconcileStripeFullRefund },
      baseRefund({ status: "succeeded", amount: 3000 }),
    );

    expect(getChargeRefundState).toHaveBeenCalledWith({ chargeId: "ch_abc" });
    expect(reconcileStripeFullRefund).toHaveBeenCalledWith({
      paymentIntentId: "pi_xyz",
      amountRefundedCents: 11000,
      currency: "usd",
      refundId: "re_test_123",
      sourceEventType: "charge.refund.updated",
      fullyRefundedHint: true,
    });
  });

  it("does not reconcile succeeded refunds without a charge id", async () => {
    const logger = makeLogger();
    const getChargeRefundState = vi.fn();
    const reconcileStripeFullRefund = vi.fn();

    await onRefundUpdated(
      { logger, getChargeRefundState, reconcileStripeFullRefund },
      baseRefund({ status: "succeeded", charge: null }),
    );

    expect(getChargeRefundState).not.toHaveBeenCalled();
    expect(reconcileStripeFullRefund).not.toHaveBeenCalled();
  });
});
