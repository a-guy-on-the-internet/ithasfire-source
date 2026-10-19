import { describe, expect, it } from "vitest";

import {
  CustomerUpdatedZ,
  MembershipInvoiceZ,
  MembershipSubscriptionZ,
  customerBillingAddress,
  membershipInvoiceExclusiveTaxCents,
  membershipInvoiceSubscriptionMetadata,
  membershipInvoiceSubscriptionId,
  membershipSubscriptionPeriod,
} from "../guards";

const START_S = 1_780_000_000;
const END_S = 1_782_000_000;

function baseInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_1",
    object: "invoice" as const,
    currency: "usd",
    subtotal: 1000,
    amount_paid: 1098,
    amount_due: 1098,
    created: START_S,
    period_start: START_S,
    period_end: END_S,
    ...overrides,
  };
}

describe("MembershipInvoiceZ — tax across API versions", () => {
  it("sums ONLY exclusive entries when total_taxes is present (Basil)", () => {
    const invoice = MembershipInvoiceZ.parse(
      baseInvoice({
        total_taxes: [
          { amount: 98, tax_behavior: "exclusive" },
          { amount: 7, tax_behavior: "inclusive" },
        ],
      }),
    );
    expect(membershipInvoiceExclusiveTaxCents(invoice)).toBe(98);
  });

  it("falls back to the LEGACY `tax` integer when total_taxes is absent", () => {
    // Pre-Basil invoices carry `tax`, not `total_taxes[]`. Without the
    // fallback a replayed older event records 0 tax — the collected tax
    // silently becomes owner revenue.
    const invoice = MembershipInvoiceZ.parse(baseInvoice({ tax: 98 }));
    expect(membershipInvoiceExclusiveTaxCents(invoice)).toBe(98);
  });

  it("total_taxes WINS when both shapes are present", () => {
    // A migrated payload could carry both; total_taxes has the per-entry
    // tax_behavior that the exclusive filter needs, so it is authoritative.
    const invoice = MembershipInvoiceZ.parse(
      baseInvoice({
        tax: 999,
        total_taxes: [{ amount: 98, tax_behavior: "exclusive" }],
      }),
    );
    expect(membershipInvoiceExclusiveTaxCents(invoice)).toBe(98);
  });

  it("reports 0 when neither shape is present", () => {
    const invoice = MembershipInvoiceZ.parse(baseInvoice());
    expect(membershipInvoiceExclusiveTaxCents(invoice)).toBe(0);
  });
});

describe("membershipInvoiceSubscriptionMetadata", () => {
  it("reads the Basil location (parent.subscription_details.metadata)", () => {
    const invoice = MembershipInvoiceZ.parse(
      baseInvoice({
        parent: {
          subscription_details: {
            subscription: "sub_1",
            metadata: { tierId: "tier-1", memberHumanId: "human-1" },
          },
        },
      }),
    );
    expect(membershipInvoiceSubscriptionMetadata(invoice)).toEqual({
      tierId: "tier-1",
      memberHumanId: "human-1",
    });
    expect(membershipInvoiceSubscriptionId(invoice)).toBe("sub_1");
  });

  it("falls back to the legacy top-level subscription_details.metadata", () => {
    const invoice = MembershipInvoiceZ.parse(
      baseInvoice({
        subscription: "sub_1",
        subscription_details: { metadata: { tierId: "tier-1" } },
      }),
    );
    expect(membershipInvoiceSubscriptionMetadata(invoice)).toEqual({
      tierId: "tier-1",
    });
  });

  it("is null when the payload carries no subscription metadata", () => {
    const invoice = MembershipInvoiceZ.parse(baseInvoice());
    expect(membershipInvoiceSubscriptionMetadata(invoice)).toBeNull();
  });
});

describe("MembershipSubscriptionZ — billing period across API versions", () => {
  it("reads the period off items.data[0] (Basil)", () => {
    const subscription = MembershipSubscriptionZ.parse({
      id: "sub_1",
      object: "subscription",
      status: "active",
      items: {
        data: [{ current_period_start: START_S, current_period_end: END_S }],
      },
    });
    expect(membershipSubscriptionPeriod(subscription)).toEqual({
      start: new Date(START_S * 1000),
      end: new Date(END_S * 1000),
    });
  });

  it("falls back to the LEGACY top-level current_period_* fields", () => {
    // A pre-Basil event has the period at the top level and no per-item copy.
    // Parsing it to null would defeat syncMembershipFromStripe's out-of-order
    // guard and let a stale replayed `active` overwrite a newer state.
    const subscription = MembershipSubscriptionZ.parse({
      id: "sub_1",
      object: "subscription",
      status: "active",
      current_period_start: START_S,
      current_period_end: END_S,
      items: { data: [{}] },
    });
    expect(membershipSubscriptionPeriod(subscription)).toEqual({
      start: new Date(START_S * 1000),
      end: new Date(END_S * 1000),
    });
  });

  it("prefers the item-level period when both are present", () => {
    const subscription = MembershipSubscriptionZ.parse({
      id: "sub_1",
      object: "subscription",
      status: "active",
      current_period_start: 1,
      current_period_end: 2,
      items: {
        data: [{ current_period_start: START_S, current_period_end: END_S }],
      },
    });
    expect(membershipSubscriptionPeriod(subscription)).toEqual({
      start: new Date(START_S * 1000),
      end: new Date(END_S * 1000),
    });
  });

  it("returns nulls when neither location carries a period", () => {
    const subscription = MembershipSubscriptionZ.parse({
      id: "sub_1",
      object: "subscription",
      status: "canceled",
      items: { data: [] },
    });
    expect(membershipSubscriptionPeriod(subscription)).toEqual({
      start: null,
      end: null,
    });
  });
});

describe("CustomerUpdatedZ + customerBillingAddress", () => {
  it("parses a full customer and extracts the billing address, uppercased", () => {
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
      email: "member@example.com",
      address: {
        line1: "123 Main St",
        city: "Portland",
        state: "OR",
        postal_code: "97202-1234",
        country: "us",
      },
    });
    expect(customerBillingAddress(customer)).toEqual({
      postalCode: "97202-1234",
      countryCode: "US",
    });
  });

  it("survives a customer with an explicit null address — payment-method updates fire this event", () => {
    // A parse failure here would DLQ every card update on the platform.
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
      address: null,
    });
    expect(customerBillingAddress(customer)).toBeNull();
  });

  it("survives a missing address field entirely", () => {
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
    });
    expect(customerBillingAddress(customer)).toBeNull();
  });

  it("treats a partial address (no postal code) as unusable", () => {
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
      address: { country: "US", postal_code: null },
    });
    expect(customerBillingAddress(customer)).toBeNull();
  });

  it("treats a malformed country as unusable rather than DLQ-fodder", () => {
    // Portal-typed garbage is not retryable; the handler no-ops on null.
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
      address: { country: "USA", postal_code: "97202" },
    });
    expect(customerBillingAddress(customer)).toBeNull();
  });

  it("treats a postal code beyond the resolver's 16-char bound as unusable", () => {
    const customer = CustomerUpdatedZ.parse({
      id: "cus_1",
      object: "customer",
      address: { country: "US", postal_code: "9".repeat(17) },
    });
    expect(customerBillingAddress(customer)).toBeNull();
  });

  it("rejects a non-customer object", () => {
    expect(
      CustomerUpdatedZ.safeParse({ id: "sub_1", object: "subscription" })
        .success,
    ).toBe(false);
  });
});
