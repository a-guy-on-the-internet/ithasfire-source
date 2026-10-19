import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { EarlyFraudWarningRecord } from "@th/ports/repos/early-fraud-warnings";
import type { Repos } from "@th/ports/repos";

import { getOrgOrder } from "../get-org-order";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const STRIPE_CREATED_AT = new Date("2026-09-02T11:58:00.000Z");

function warning(overrides: Partial<EarlyFraudWarningRecord> = {}): EarlyFraudWarningRecord {
  return {
    id: "efw_1",
    stripeEfwId: "issfr_123",
    stripeChargeId: "ch_123",
    paymentIntentId: "pi_123",
    orderId: ORDER_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    fraudType: "made_with_stolen_card",
    actionable: true,
    stripeCreatedAt: STRIPE_CREATED_AT,
    resolvedAt: null,
    resolution: null,
    createdAt: STRIPE_CREATED_AT,
    updatedAt: STRIPE_CREATED_AT,
    ...overrides,
  };
}

function makeDeps(
  active: EarlyFraudWarningRecord | null,
  options: { lookupThrows?: boolean } = {},
) {
  const findActiveForOrder = vi.fn(async () => {
    if (options.lookupThrows) throw new Error("efw table down");
    return active;
  });
  const order = {
    id: ORDER_ID,
    eventId: EVENT_ID,
    kind: "TICKETING",
    buyerHumanId: BUYER_ID,
    amountGrossCents: 5_000,
    feesPlatformCents: 150,
    taxAmountCents: 400,
    currency: "usd",
    status: "SUCCEEDED",
    source: "PRIMARY",
    stripePaymentIntentId: "pi_123",
    stripeTaxCalculationId: null,
    paymentMethodType: "card",
    parentOrderId: null,
    feePolicySnapshot: {},
    billingAddressLine1: null,
    occurredAt: new Date("2026-05-01T15:00:00.000Z"),
    paidOutAt: null,
    disputeStatus: null,
    items: [],
  };
  const repos = {
    orders: { getById: vi.fn(async () => order) },
    events: {
      getById: vi.fn(async () => ({ id: EVENT_ID, orgId: ORG_ID, title: "Rock Show" })),
      listTicketTypes: vi.fn(async () => []),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
    },
    promos: { listRedemptionsByOrderId: vi.fn(async () => []) },
    organizations: { getById: vi.fn(async () => ({ id: ORG_ID, name: "Drkmttr" })) },
    tickets: { listByOrderItemIds: vi.fn(async () => []) },
    earlyFraudWarnings: { findActiveForOrder },
    // The event credit's ledger read (OrderSplit rows); none written here.
    splits: { getForOrder: vi.fn(async () => []) },
  } as unknown as Repos;
  const authz = {
    canFinanceOrg: vi.fn(async () => ({ allowed: true })),
  } as unknown as AuthZPort;
  const reportError = vi.fn();
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), child: vi.fn() };
  logger.child.mockReturnValue(logger);
  return {
    deps: { repos, authz, reportError, logger: logger as never },
    findActiveForOrder,
    reportError,
    logger,
  };
}

describe("getOrgOrder — earlyFraudWarning", () => {
  it("surfaces the active warning's type, Stripe timestamp and actionable flag", async () => {
    const ctx = makeDeps(warning());

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(ctx.findActiveForOrder).toHaveBeenCalledWith(ORDER_ID);
    expect(out.earlyFraudWarning).toEqual({
      fraudType: "made_with_stolen_card",
      stripeCreatedAt: STRIPE_CREATED_AT,
      actionable: true,
    });
  });

  it("treats a Stripe-side actionable=false warning as nothing to do (null)", async () => {
    // `.updated` flips actionable off when the charge is refunded/disputed out
    // of band; our REFUNDED hook rides `charge.refunded` and may lag or DLQ.
    const ctx = makeDeps(warning({ actionable: false }));

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(out.earlyFraudWarning).toBeNull();
  });

  it("a failing lookup degrades to null and is reported, never failing the order read", async () => {
    const ctx = makeDeps(warning(), { lookupThrows: true });

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(out.id).toBe(ORDER_ID);
    expect(out.earlyFraudWarning).toBeNull();
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "getOrgOrder", source: "earlyFraudWarning" },
        extra: { orderId: ORDER_ID },
      }),
    );
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "get_org_order.early_fraud_warning_lookup_failed",
      expect.objectContaining({ orderId: ORDER_ID }),
    );
  });

  it("a throwing reporter does not change the degraded result", async () => {
    const ctx = makeDeps(warning(), { lookupThrows: true });
    ctx.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(out.earlyFraudWarning).toBeNull();
  });

  it("is null when the order was never warned (or the warning is resolved)", async () => {
    const ctx = makeDeps(null);

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(out.earlyFraudWarning).toBeNull();
  });
});
