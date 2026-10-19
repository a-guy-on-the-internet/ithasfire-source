import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { cancelMembership } from "../cancel-membership";
import {
  MEMBERSHIP_BENEFIT_GRANTING_STATUSES,
  MEMBERSHIP_LIVE_STATUSES,
} from "../membership-status";
import { startMembership } from "../start-membership";

const TIER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("startMembership", () => {
  it("creates a PLATFORM subscription — no destination account, no application fee", async () => {
    // The owner is paid by the Orders/Settlement pipeline; routing funds on
    // the subscription too would pay them twice (spec 2026-08-08 revision:
    // "No `transfer_data.destination`.").
    const ctx = makeCtx();

    await startMembership(ctx.deps, baseInput());

    expect(ctx.billing.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cus_1",
        priceId: "price_1",
      }),
    );
    const input = ctx.billing.createSubscription.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(input)).not.toContain("destinationAccountId");
    expect(Object.keys(input)).not.toContain("applicationFeePercent");
  });

  it("resolves tax BEFORE touching Stripe, so a refusal strands nothing", async () => {
    const ctx = makeCtx({ cached: false });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue(null);

    await expect(startMembership(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "TAX_JURISDICTION_UNSUPPORTED",
    });

    // No Customer, no Subscription — nothing to reconcile later.
    expect(ctx.billing.ensureCustomer).not.toHaveBeenCalled();
    expect(ctx.billing.createSubscription).not.toHaveBeenCalled();
    expect(ctx.memberships.create).not.toHaveBeenCalled();
  });

  it("mints and attaches a Stripe TaxRate lazily on first use", async () => {
    const ctx = makeCtx();

    await startMembership(ctx.deps, baseInput());

    expect(ctx.billing.ensureTaxRate).toHaveBeenCalledWith(
      expect.objectContaining({ percentage: 9.75, inclusive: false }),
    );
    expect(ctx.jurisdictions.attachStripeTaxRateId).toHaveBeenCalledWith({
      id: "jur_1",
      stripeTaxRateId: "txr_1",
    });
    expect(ctx.billing.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTaxRateIds: ["txr_1"] }),
    );
  });

  it("attaches NO tax rate for a genuine 0% jurisdiction", async () => {
    const ctx = makeCtx({ rateBps: 0 });

    await startMembership(ctx.deps, baseInput());

    // Creating a 0% TaxRate object would be pure noise on the Stripe account.
    expect(ctx.billing.ensureTaxRate).not.toHaveBeenCalled();
    expect(ctx.billing.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTaxRateIds: [] }),
    );
  });

  it("is idempotent on a live membership — a double submit bills once", async () => {
    const ctx = makeCtx({ existing: buildMembership({ status: "active" }) });

    const result = await startMembership(ctx.deps, baseInput());

    expect(result.id).toBe(MEMBERSHIP_ID);
    expect(ctx.billing.createSubscription).not.toHaveBeenCalled();
  });

  it("resumes a lapsed membership rather than orphaning the row — and re-points it WHOLESALE at the new subscription", async () => {
    // The lapsed row points at a dead subscription with stale billing/tax
    // linkage; the resume must replace ALL of it, not just the status. A
    // partial update (the old `updateFromStripe` shape) left the row on
    // `sub_dead`, so every invoice for the NEW subscription missed the row
    // and DLQ'd forever — member billed, owner unpaid.
    const ctx = makeCtx({
      existing: buildMembership({
        status: "canceled",
        stripeSubscriptionId: "sub_dead",
        stripeCustomerId: "cus_dead",
        taxJurisdictionId: "jur_old",
        billingPostalCode: "10001",
        canceledAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    });

    await startMembership(ctx.deps, baseInput());

    // The (tierId, memberHumanId) unique index means a returning member cannot
    // get a second row — so this must UPDATE, not create. The status is
    // Stripe's verbatim: a fresh default_incomplete subscription is
    // `incomplete` until the browser confirms its first invoice.
    expect(ctx.billing.createSubscription).toHaveBeenCalled();
    expect(ctx.memberships.create).not.toHaveBeenCalled();
    // Exact-argument assertion, deliberately NOT objectContaining: the
    // regression this pins was invisible to a loose match — every field of
    // the fresh subscription + newly-resolved jurisdiction must persist.
    expect(ctx.memberships.resumeFromStripe).toHaveBeenCalledWith({
      id: MEMBERSHIP_ID,
      stripeSubscriptionId: "sub_1", // the NEW subscription — never sub_dead
      stripeCustomerId: "cus_1",
      status: "incomplete",
      taxJurisdictionId: "jur_1", // re-resolved at resume time
      billingPostalCode: "37206",
      billingCountryCode: "US",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null, // the row is live again
    });
    // The narrow webhook-sync method must NOT be the resume path — it cannot
    // carry the subscription re-point (by design).
    expect(ctx.memberships.updateFromStripe).not.toHaveBeenCalled();
  });

  it("after a canceled→rejoin, the webhook lookup by the NEW subscription id finds the row", async () => {
    // Simulates the exact read `recordMembershipInvoicePaid` performs when
    // the new subscription's first invoice lands
    // (`findByStripeSubscriptionId(sub_new)`). Pre-fix this returned null —
    // the metadata-stamp path threw MEMBERSHIP_NOT_FOUND into the DLQ for
    // every invoice, forever.
    let row = buildMembership({
      status: "canceled",
      stripeSubscriptionId: "sub_dead",
      canceledAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const ctx = makeCtx({ existing: row });
    ctx.memberships.resumeFromStripe.mockImplementation(
      async (input: Partial<MembershipRecord> & { id: string }) => {
        row = { ...row, ...input };
        return row;
      },
    );
    ctx.memberships.findByStripeSubscriptionId.mockImplementation(
      async (subscriptionId: string) =>
        row.stripeSubscriptionId === subscriptionId ? row : null,
    );
    ctx.billing.createSubscription.mockResolvedValue({
      subscriptionId: "sub_new",
      status: "incomplete",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: "pi_1_secret_test",
    } as never);

    await startMembership(ctx.deps, baseInput());

    await expect(
      ctx.memberships.findByStripeSubscriptionId("sub_new"),
    ).resolves.toMatchObject({
      id: MEMBERSHIP_ID,
      stripeSubscriptionId: "sub_new",
      canceledAt: null,
    });
    // The dead subscription no longer resolves to the row.
    await expect(
      ctx.memberships.findByStripeSubscriptionId("sub_dead"),
    ).resolves.toBeNull();
  });

  it("persists the row with Stripe's `incomplete` status and returns the first invoice's client secret for Elements", async () => {
    const ctx = makeCtx();

    const result = await startMembership(ctx.deps, baseInput());

    // The row exists immediately (webhooks need something to sync onto), in
    // the status Stripe actually reported — not an optimistic "active".
    expect(ctx.memberships.create).toHaveBeenCalledWith(
      expect.objectContaining({ status: "incomplete" }),
    );
    // The browser confirms this with Stripe Elements; confirmation attaches
    // the card and webhooks flip the subscription active.
    expect(result.paymentIntentClientSecret).toBe("pi_1_secret_test");
  });

  it("returns a NULL client secret when the first invoice needs no payment", async () => {
    const ctx = makeCtx();
    ctx.billing.createSubscription.mockResolvedValue({
      subscriptionId: "sub_1",
      status: "active",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: null,
    } as never);

    const result = await startMembership(ctx.deps, baseInput());

    expect(result.paymentIntentClientSecret).toBeNull();
  });

  it("never logs the client secret", async () => {
    const ctx = makeCtx();

    await startMembership(ctx.deps, baseInput());

    const logged = JSON.stringify(
      (ctx.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls,
    );
    expect(logged).not.toContain("pi_1_secret_test");
  });

  it("returns no client secret on the double-submit early return — nothing to pay", async () => {
    const ctx = makeCtx({ existing: buildMembership({ status: "active" }) });

    const result = await startMembership(ctx.deps, baseInput());

    expect(result.paymentIntentClientSecret).toBeNull();
  });

  it("refuses when the owner has no charges-enabled connected account", async () => {
    const ctx = makeCtx({ payee: { stripeAccountId: null, chargesEnabled: false } });

    await expect(startMembership(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "PAYEE_NOT_READY",
    });
    expect(ctx.billing.createSubscription).not.toHaveBeenCalled();
  });

  it("refuses a tier that is not published", async () => {
    const ctx = makeCtx({ tier: buildTier({ status: "DRAFT", stripePriceId: null }) });

    await expect(startMembership(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "MEMBERSHIP_TIER_NOT_ACTIVE",
    });
  });

  it("refuses while the owner is suspended", async () => {
    const ctx = makeCtx({ suspended: true });

    await expect(startMembership(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "MEMBERSHIPS_SUSPENDED",
    });
  });
});

describe("cancelMembership", () => {
  it("defaults to end-of-period so a paid-for period is kept", async () => {
    const ctx = makeCtx({ existing: buildMembership({ status: "active" }) });

    await cancelMembership(ctx.deps, {
      membershipId: MEMBERSHIP_ID,
      actorHumanId: MEMBER_ID,
    });

    expect(ctx.billing.cancelSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ atPeriodEnd: true }),
    );
  });

  it("cancels immediately only when explicitly asked", async () => {
    const ctx = makeCtx({ existing: buildMembership({ status: "active" }) });

    await cancelMembership(ctx.deps, {
      membershipId: MEMBERSHIP_ID,
      actorHumanId: MEMBER_ID,
      immediate: true,
    });

    expect(ctx.billing.cancelSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ atPeriodEnd: false }),
    );
  });

  it("refuses to cancel someone else's membership", async () => {
    const ctx = makeCtx({ existing: buildMembership({ status: "active" }) });

    // Billing-grade IDOR if this ever passes.
    await expect(
      cancelMembership(ctx.deps, {
        membershipId: MEMBERSHIP_ID,
        actorHumanId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_MISMATCH" });
    expect(ctx.billing.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe("incomplete subscription statuses", () => {
  // Lifecycle pin for the default_incomplete flow: a subscription whose first
  // invoice is never confirmed sits `incomplete`, then auto-expires to
  // `incomplete_expired` after ~23h. Neither state may grant benefits (an
  // unpaid signup earns nothing) NOR count as live (the member must be able
  // to come back and join again — a "live" incomplete row would make the
  // double-subscribe guard permanently block the retry).
  it("`incomplete` and `incomplete_expired` grant NO benefits", () => {
    expect(MEMBERSHIP_BENEFIT_GRANTING_STATUSES).not.toContain("incomplete");
    expect(MEMBERSHIP_BENEFIT_GRANTING_STATUSES).not.toContain(
      "incomplete_expired",
    );
  });

  it("`incomplete` and `incomplete_expired` are NOT live — an abandoned signup can be retried", () => {
    expect(MEMBERSHIP_LIVE_STATUSES).not.toContain("incomplete");
    expect(MEMBERSHIP_LIVE_STATUSES).not.toContain("incomplete_expired");
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

function baseInput() {
  return {
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    billingCountryCode: "US",
    billingPostalCode: "37206",
  };
}

function buildTier(
  overrides: Partial<MembershipTierRecord> = {},
): MembershipTierRecord {
  return {
    id: TIER_ID,
    ownerOrgId: ORG_ID,
    ownerHumanId: null,
    name: "Sustaining Member",
    description: null,
    priceCents: 1000,
    currency: "usd",
    interval: "MONTH",
    stripeProductId: "prod_1",
    stripePriceId: "price_1",
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: MEMBER_ID,
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: "cus_1",
    status: "active",
    taxJurisdictionId: "jur_1",
    billingPostalCode: "37206",
    billingCountryCode: "US",
    currentPeriodStart: NOW,
    currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCtx(
  options: {
    tier?: MembershipTierRecord;
    existing?: MembershipRecord | null;
    suspended?: boolean;
    rateBps?: number;
    payee?: { stripeAccountId: string | null; chargesEnabled: boolean };
    /** false = nothing cached, so resolution must hit the provider. */
    cached?: boolean;
  } = {},
) {
  const rateBps = options.rateBps ?? 975;

  const cached = options.cached ?? true;

  const jurisdictions = {
    findLive: vi.fn(async () =>
      !cached
        ? null
        : ({
      id: "jur_1",
      countryCode: "US",
      postalCode: "37206",
      rateBps,
      rateSource: "ziptax",
      stripeTaxRateId: null,
      checkedAt: NOW,
      effectiveFrom: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never),
    ),
    findById: vi.fn(),
    create: vi.fn(),
    listStale: vi.fn(async () => []),
    archive: vi.fn(),
    touchCheckedAt: vi.fn(),
    attachStripeTaxRateId: vi.fn(async () => ({ id: "jur_1" })),
    migrateMemberships: vi.fn(async () => ({ migratedCount: 0 })),
  };

  const memberships = {
    findById: vi.fn(async () => options.existing ?? null),
    findForMemberAndTier: vi.fn(async () => options.existing ?? null),
    findByStripeSubscriptionId: vi.fn(async () => options.existing ?? null),
    create: vi.fn(async () => buildMembership()),
    updateFromStripe: vi.fn(async () => buildMembership()),
    resumeFromStripe: vi.fn(async () => buildMembership()),
    listForMember: vi.fn(async () => []),
  };

  const payee = options.payee ?? {
    stripeAccountId: "acct_owner",
    chargesEnabled: true,
  };

  const billing = {
    ensureCustomer: vi.fn(async () => ({ customerId: "cus_1" })),
    ensureProduct: vi.fn(),
    createPrice: vi.fn(),
    ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_1" })),
    // `default_incomplete` reality: a fresh subscription has no card yet, so
    // Stripe answers `incomplete` plus the first invoice's PI client secret.
    createSubscription: vi.fn(async () => ({
      subscriptionId: "sub_1",
      status: "incomplete",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: "pi_1_secret_test",
    })),
    cancelSubscription: vi.fn(async () => ({
      subscriptionId: "sub_1",
      status: "active",
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date("2026-09-10T12:00:00.000Z"),
      cancelAtPeriodEnd: true,
      canceledAt: null,
      paymentIntentClientSecret: null,
    })),
    getSubscription: vi.fn(),
    createPortalSession: vi.fn(),
  };

  const taxRateLookup = {
    lookupByPostalCode: vi.fn(async () => ({ rateBps, source: "ziptax" })),
  };

  return {
    jurisdictions,
    memberships,
    billing,
    taxRateLookup,
    deps: {
      repos: {
        membershipTiers: {
          findById: vi.fn(async () => options.tier ?? buildTier()),
        },
        membershipStandings: {
          findForOwner: vi.fn(async () =>
            options.suspended ? { suspended: true } : null,
          ),
        },
        membershipTaxJurisdictions: jurisdictions,
        memberships,
        payees: {
          getBySubject: vi.fn(async () => ({ id: "payee_1" })),
          getById: vi.fn(async () => payee),
        },
      } as unknown as Repos,
      membershipBilling: billing as never,
      taxRateLookup: taxRateLookup as never,
      clock: { now: () => NOW },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      reportError: vi.fn(),
    },
  };
}
