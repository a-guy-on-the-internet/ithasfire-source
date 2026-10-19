import { describe, expect, it, vi } from "vitest";

import type { EarlyFraudWarningRecord } from "@th/ports/repos/early-fraud-warnings";
import type { Repos, TxRepos } from "@th/ports/repos";

import { resolveEarlyFraudWarning } from "../resolve-early-fraud-warning";

const NOW = new Date("2026-09-04T09:00:00.000Z");

function warning(overrides: Partial<EarlyFraudWarningRecord> = {}): EarlyFraudWarningRecord {
  return {
    id: "efw_1",
    stripeEfwId: "issfr_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    orderId: "order_1",
    ownerOrgId: "org_1",
    ownerHumanId: null,
    fraudType: "made_with_stolen_card",
    actionable: true,
    stripeCreatedAt: new Date("2026-09-02T11:58:00.000Z"),
    resolvedAt: null,
    resolution: null,
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
    updatedAt: new Date("2026-09-02T12:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(
  active: EarlyFraudWarningRecord | null,
  options: { casMiss?: boolean; orderStatus?: string | null } = {},
) {
  const audit = vi.fn(async () => undefined);
  const markResolved = vi.fn(async (input) =>
    active && !options.casMiss
      ? { ...active, resolvedAt: input.resolvedAt, resolution: input.resolution }
      : null,
  );
  const orders = {
    getById: vi.fn(async (id: string) =>
      options.orderStatus && active?.orderId === id
        ? { id, status: options.orderStatus }
        : null,
    ),
    findByPaymentIntent: vi.fn(async (pi: string) =>
      options.orderStatus && active?.paymentIntentId === pi
        ? { id: active.orderId ?? "order_by_pi", status: options.orderStatus }
        : null,
    ),
  };
  const txRepos = {
    earlyFraudWarnings: {
      findActiveByStripeChargeId: vi.fn(async (chargeId: string) =>
        active && active.stripeChargeId === chargeId ? active : null,
      ),
      markResolved,
    },
    orders,
    audit: { log: audit },
  } as unknown as TxRepos;
  const repos = {
    ...txRepos,
    tx: vi.fn(async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos)),
  } as unknown as Repos;
  return { deps: { repos, clock: { now: () => NOW } }, audit, markResolved, orders };
}

describe("resolveEarlyFraudWarning", () => {
  it("marks the active warning DISPUTED and audits the source", async () => {
    const ctx = makeDeps(warning());

    const result = await resolveEarlyFraudWarning(ctx.deps, {
      stripeChargeId: "ch_123",
      resolution: "DISPUTED",
      stripeEventId: "evt_dp",
      stripeEventType: "charge.dispute.created",
      sourceId: "dp_123",
    });

    expect(result).toEqual({
      ok: true,
      resolved: true,
      earlyFraudWarningId: "efw_1",
      resolution: "DISPUTED",
      skippedReason: null,
    });
    expect(ctx.markResolved).toHaveBeenCalledWith({
      id: "efw_1",
      resolution: "DISPUTED",
      resolvedAt: NOW,
    });
    expect(ctx.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "early_fraud_warning",
        entityId: "efw_1",
        action: "early_fraud_warning.resolved",
        at: NOW,
        data: expect.objectContaining({
          resolution: "DISPUTED",
          sourceId: "dp_123",
          stripeEventId: "evt_dp",
          orderId: "order_1",
        }),
      }),
    );
  });

  it("is a no-op for a charge with no active warning", async () => {
    const ctx = makeDeps(null);

    const result = await resolveEarlyFraudWarning(ctx.deps, {
      stripeChargeId: "ch_never_warned",
      resolution: "REFUNDED",
    });

    expect(result).toEqual({
      ok: true,
      resolved: false,
      earlyFraudWarningId: null,
      resolution: null,
      skippedReason: "no_active_warning",
    });
    expect(ctx.markResolved).not.toHaveBeenCalled();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("keeps the first resolution when the compare-and-set misses (a refund after the dispute stays DISPUTED)", async () => {
    const ctx = makeDeps(warning(), { casMiss: true });

    const result = await resolveEarlyFraudWarning(ctx.deps, {
      stripeChargeId: "ch_123",
      resolution: "REFUNDED",
    });

    expect(result).toMatchObject({
      resolved: false,
      earlyFraudWarningId: "efw_1",
      skippedReason: "already_resolved",
    });
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  describe("REFUNDED via charge.refunded facts", () => {
    const refundedByStripe = { stripeFullyRefunded: true, amountRefundedCents: 5_129 };
    // Platform refund: processing fee withheld, so Stripe reports a partial.
    const platformRefund = { stripeFullyRefunded: false, amountRefundedCents: 4_933 };

    it("Stripe-full refund resolves without consulting the order", async () => {
      const ctx = makeDeps(warning());
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "REFUNDED",
        refund: refundedByStripe,
      });
      expect(result).toMatchObject({ resolved: true, resolution: "REFUNDED" });
      expect(ctx.orders.getById).not.toHaveBeenCalled();
      expect(ctx.audit.mock.calls[0]?.[0]).toMatchObject({
        data: expect.objectContaining({ refund: refundedByStripe }),
      });
    });

    it("a Stripe-partial refund resolves when the LOCAL order reads REFUNDED (platform-full, fee withheld)", async () => {
      const ctx = makeDeps(warning(), { orderStatus: "REFUNDED" });
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "REFUNDED",
        refund: platformRefund,
      });
      expect(result).toMatchObject({ resolved: true, resolution: "REFUNDED" });
      expect(ctx.orders.getById).toHaveBeenCalledWith("order_1");
    });

    it("a Stripe-partial refund on a PART_REFUNDED order leaves the warning open", async () => {
      const ctx = makeDeps(warning(), { orderStatus: "PART_REFUNDED" });
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "REFUNDED",
        refund: platformRefund,
      });
      expect(result).toEqual({
        ok: true,
        resolved: false,
        earlyFraudWarningId: "efw_1",
        resolution: null,
        skippedReason: "partial_refund",
      });
      expect(ctx.markResolved).not.toHaveBeenCalled();
      expect(ctx.audit).not.toHaveBeenCalled();
    });

    it("falls back to the PaymentIntent lookup when the warning has no order link", async () => {
      const ctx = makeDeps(warning({ orderId: null }), { orderStatus: "REFUNDED" });
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "REFUNDED",
        refund: platformRefund,
      });
      expect(result).toMatchObject({ resolved: true });
      expect(ctx.orders.findByPaymentIntent).toHaveBeenCalledWith("pi_123");
    });

    it("zero refunded cents never resolves, whatever the order says", async () => {
      const ctx = makeDeps(warning(), { orderStatus: "REFUNDED" });
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "REFUNDED",
        refund: { stripeFullyRefunded: false, amountRefundedCents: 0 },
      });
      expect(result).toMatchObject({ resolved: false, skippedReason: "partial_refund" });
    });

    it("the refund facts do not gate a DISPUTED resolution", async () => {
      const ctx = makeDeps(warning(), { orderStatus: "PART_REFUNDED" });
      const result = await resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "DISPUTED",
        refund: platformRefund,
      });
      expect(result).toMatchObject({ resolved: true, resolution: "DISPUTED" });
    });
  });

  it("rejects an unknown resolution at the boundary", async () => {
    const ctx = makeDeps(warning());
    await expect(
      resolveEarlyFraudWarning(ctx.deps, {
        stripeChargeId: "ch_123",
        resolution: "WHATEVER",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
