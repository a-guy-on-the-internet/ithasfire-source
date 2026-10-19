import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { DisputeStatus } from "@th/types/repos/disputes";
import type { Repos } from "@th/ports/repos";

import { getOrgOrder } from "../get-org-order";

const ACTOR_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ID = "33333333-3333-4333-8333-333333333333";
const STRIPE_CREATED_AT = new Date("2026-09-02T11:58:00.000Z");

function makeDeps(disputeStatus: DisputeStatus | null) {
  const findActiveForOrder = vi.fn(async () => null);
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
    disputeStatus,
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
  return { deps: { repos, authz }, findActiveForOrder };
}

describe("getOrgOrder — refundBlockedByDispute", () => {
  // Derived server-side by the SAME rule the refund use cases apply, so the
  // admin panel never re-encodes which dispute statuses block a refund.
  it.each([
    ["OPEN", true],
    ["WON", false],
    [null, false],
  ] as const)("disputeStatus %s → refundBlockedByDispute %s", async (disputeStatus, blocked) => {
    const ctx = makeDeps(disputeStatus);

    const out = await getOrgOrder(ctx.deps, {
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      orderId: ORDER_ID,
    });

    expect(out.disputeStatus).toBe(disputeStatus);
    expect(out.refundBlockedByDispute).toBe(blocked);
  });
});
