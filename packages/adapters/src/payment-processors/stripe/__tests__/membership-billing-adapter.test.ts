import { describe, expect, it, vi } from "vitest";

import { StripeMembershipBilling } from "../membership-billing-adapter";

const NOW_S = 1_780_000_000;

function stubSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_test_1",
    status: "active",
    cancel_at_period_end: false,
    canceled_at: null,
    items: {
      data: [
        {
          current_period_start: NOW_S,
          current_period_end: NOW_S + 2_592_000,
        },
      ],
    },
    ...overrides,
  };
}

describe("StripeMembershipBilling.createSubscription", () => {
  it("sends the platform-account params: customer, items, tax rates, metadata", async () => {
    const create = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    const snapshot = await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
      defaultTaxRateIds: ["txr_1"],
      metadata: { tierId: "tier-1", memberHumanId: "human-1" },
      idempotencyKey: "membership-subscription:tier-1:human-1",
    });

    const [params, options] = create.mock.calls[0] ?? [];
    expect(params).toEqual(
      expect.objectContaining({
        customer: "cus_1",
        items: [{ price: "price_1" }],
        default_tax_rates: ["txr_1"],
        metadata: { tierId: "tier-1", memberHumanId: "human-1" },
      }),
    );
    expect(options).toEqual({
      idempotencyKey: "membership-subscription:tier-1:human-1",
    });
    expect(snapshot.subscriptionId).toBe("sub_test_1");
    expect(snapshot.currentPeriodStart).toEqual(new Date(NOW_S * 1000));
  });

  it("creates the subscription default_incomplete, saves the confirmed card for renewals, and expands the first invoice's confirmation secret", async () => {
    // The platform-owned Customer has no payment method at signup — the whole
    // reason this exists. Without `default_incomplete` Stripe rejects with
    // "customer has no attached payment source" and NO member can ever join.
    const create = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
    });

    const [params] = create.mock.calls[0] ?? [];
    expect(params).toEqual(
      expect.objectContaining({
        payment_behavior: "default_incomplete",
        payment_settings: { save_default_payment_method: "on_subscription" },
        // Basil: `Invoice.payment_intent` is gone; the client secret lives at
        // `latest_invoice.confirmation_secret` and only arrives when expanded.
        expand: ["latest_invoice.confirmation_secret"],
      }),
    );
  });

  it("returns the first invoice's PaymentIntent client secret off the expanded confirmation_secret", async () => {
    const create = vi.fn(async () =>
      stubSubscription({
        status: "incomplete",
        latest_invoice: {
          id: "in_1",
          confirmation_secret: {
            client_secret: "pi_1_secret_abc",
            type: "payment_intent",
          },
        },
      }),
    );
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    const snapshot = await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
    });

    expect(snapshot.status).toBe("incomplete");
    expect(snapshot.paymentIntentClientSecret).toBe("pi_1_secret_abc");
  });

  it("returns a null client secret when the first invoice needs no payment (no confirmation_secret)", async () => {
    // 100%-discounted or trialing first invoice: Stripe mints no
    // PaymentIntent, so there is nothing to confirm.
    const create = vi.fn(async () =>
      stubSubscription({
        latest_invoice: { id: "in_1", confirmation_secret: null },
      }),
    );
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    const snapshot = await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
    });

    expect(snapshot.paymentIntentClientSecret).toBeNull();
  });

  it("returns a null client secret on reads/cancels, where latest_invoice is an unexpanded id", async () => {
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = {
      subscriptions: {
        retrieve: vi.fn(async () =>
          stubSubscription({ latest_invoice: "in_1" }),
        ),
      },
    };

    const snapshot = await billing.getSubscription({
      subscriptionId: "sub_test_1",
    });

    expect(snapshot?.paymentIntentClientSecret).toBeNull();
  });

  it("REGRESSION: the subscription-create request carries NO transfer_data and NO application_fee_percent", async () => {
    // The recurring-memberships spec (2026-08-08 revision) removed destination
    // charges: membership money settles as Orders and is paid out by
    // `runPayoutBatch`. A `transfer_data.destination` here would move the
    // money a SECOND time — every membership charge would pay the owner twice.
    const create = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
      defaultTaxRateIds: ["txr_1"],
      metadata: { tierId: "tier-1" },
      idempotencyKey: "membership-subscription:tier-1:human-1",
    });

    const [params] = create.mock.calls[0] ?? [];
    // Key-level assertions: the fields must be ABSENT, not merely falsy —
    // Stripe treats an explicit null/0 as a real instruction.
    expect(Object.keys(params as Record<string, unknown>)).not.toContain(
      "transfer_data",
    );
    expect(Object.keys(params as Record<string, unknown>)).not.toContain(
      "application_fee_percent",
    );
    // Body-level assertion, mirroring stripe-adapter.e2e.test.ts: nothing
    // nested may smuggle either field in.
    const bodyJoined = JSON.stringify(params);
    expect(bodyJoined).not.toContain("transfer_data");
    expect(bodyJoined).not.toContain("application_fee_percent");
  });

  it("omits default_tax_rates entirely for a genuine 0% jurisdiction", async () => {
    const create = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { create } };

    await billing.createSubscription({
      customerId: "cus_1",
      priceId: "price_1",
      defaultTaxRateIds: [],
    });

    const [params] = create.mock.calls[0] ?? [];
    expect(Object.keys(params as Record<string, unknown>)).not.toContain(
      "default_tax_rates",
    );
  });
});

describe("StripeMembershipBilling.ensureProduct — statement descriptor", () => {
  function makeProducts(found: Record<string, unknown> | null) {
    return {
      search: vi.fn(async () => ({ data: found ? [found] : [] })),
      update: vi.fn(async () => ({ id: "prod_existing" })),
      create: vi.fn(async () => ({ id: "prod_created" })),
    };
  }

  it("sets statement_descriptor on CREATE", async () => {
    // The descriptor is what the member's card statement shows — dispute
    // prevention item 1. Subscriptions take it from the Product; there is no
    // subscription-level field.
    const products = makeProducts(null);
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { products };

    const result = await billing.ensureProduct({
      tierId: "tier-1",
      name: "Sustaining Member",
      statementDescriptor: "DRKMTTR COLLECTIVE",
      idempotencyKey: "membership-tier-product:tier-1",
    });

    expect(result).toEqual({ productId: "prod_created" });
    const [params, options] = products.create.mock.calls[0] ?? [];
    expect(params).toEqual(
      expect.objectContaining({
        name: "Sustaining Member",
        statement_descriptor: "DRKMTTR COLLECTIVE",
        metadata: { tierId: "tier-1" },
      }),
    );
    expect(options).toEqual({
      idempotencyKey: "membership-tier-product:tier-1",
    });
  });

  it("HEALS an existing product whose descriptor differs — the republish repair path", async () => {
    // Products minted before descriptors existed (dev "Sustaining Member")
    // carry none; the next publish must update them, since Products —
    // unlike Prices — are mutable.
    const products = makeProducts({
      id: "prod_existing",
      statement_descriptor: null,
    });
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { products };

    const result = await billing.ensureProduct({
      tierId: "tier-1",
      name: "Sustaining Member",
      statementDescriptor: "DRKMTTR COLLECTIVE",
    });

    expect(result).toEqual({ productId: "prod_existing" });
    expect(products.update).toHaveBeenCalledWith("prod_existing", {
      statement_descriptor: "DRKMTTR COLLECTIVE",
    });
    expect(products.create).not.toHaveBeenCalled();
  });

  it("does NOT touch an existing product whose descriptor already matches", async () => {
    const products = makeProducts({
      id: "prod_existing",
      statement_descriptor: "DRKMTTR COLLECTIVE",
    });
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { products };

    await billing.ensureProduct({
      tierId: "tier-1",
      name: "Sustaining Member",
      statementDescriptor: "DRKMTTR COLLECTIVE",
    });

    expect(products.update).not.toHaveBeenCalled();
  });

  it("does not update when no descriptor is passed — a legacy caller cannot erase one", async () => {
    const products = makeProducts({
      id: "prod_existing",
      statement_descriptor: "DRKMTTR COLLECTIVE",
    });
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { products };

    await billing.ensureProduct({
      tierId: "tier-1",
      name: "Sustaining Member",
    });

    expect(products.update).not.toHaveBeenCalled();
  });
});

describe("StripeMembershipBilling.updateSubscriptionTaxRates", () => {
  it("re-points default_tax_rates with the idempotency key", async () => {
    const update = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { update } };

    const snapshot = await billing.updateSubscriptionTaxRates({
      subscriptionId: "sub_test_1",
      defaultTaxRateIds: ["txr_new"],
      idempotencyKey: "membership-sub-tax:m1:j1",
    });

    expect(update).toHaveBeenCalledWith(
      "sub_test_1",
      { default_tax_rates: ["txr_new"] },
      { idempotencyKey: "membership-sub-tax:m1:j1" },
    );
    expect(snapshot.subscriptionId).toBe("sub_test_1");
  });

  it("CLEARS rates with the empty-string sentinel for a genuine 0% jurisdiction", async () => {
    // An empty ARRAY is dropped by Stripe's form encoding — the field would
    // simply be omitted and the OLD rates would keep billing. Stripe's
    // documented unset is the empty string.
    const update = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { update } };

    await billing.updateSubscriptionTaxRates({
      subscriptionId: "sub_test_1",
      defaultTaxRateIds: [],
    });

    expect(update).toHaveBeenCalledWith(
      "sub_test_1",
      { default_tax_rates: "" },
      undefined,
    );
  });

  it("never smuggles transfer_data or application_fee_percent into the update", async () => {
    const update = vi.fn(async () => stubSubscription());
    const billing = new StripeMembershipBilling({ apiKey: "sk_test_x" });
    (billing as any).s = { subscriptions: { update } };

    await billing.updateSubscriptionTaxRates({
      subscriptionId: "sub_test_1",
      defaultTaxRateIds: ["txr_new"],
    });

    const [, params] = update.mock.calls[0] ?? [];
    const bodyJoined = JSON.stringify(params);
    expect(bodyJoined).not.toContain("transfer_data");
    expect(bodyJoined).not.toContain("application_fee_percent");
  });
});
