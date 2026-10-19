import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTaxJurisdictionRecord } from "@th/ports/repos/membership-tax-jurisdictions";

import { membershipRateSource } from "../resolve-member-tax-jurisdiction";
import { updateMemberBillingAddress } from "../update-member-billing-address";

const CUSTOMER_ID = "cus_member_1";
const EVENT_ID = "evt_addr_change_1";
const TIER_ID = "33333333-3333-4333-8333-333333333333";
const TIER_ID_2 = "55555555-5555-4555-8555-555555555555";
const MEMBERSHIP_ID = "66666666-6666-4666-8666-666666666666";
const MEMBERSHIP_ID_2 = "77777777-7777-4777-8777-777777777777";
const JURISDICTION_ID = "88888888-8888-4888-8888-888888888888";

function buildMembership(
  overrides: Partial<MembershipRecord> = {},
): MembershipRecord {
  return {
    id: MEMBERSHIP_ID,
    tierId: TIER_ID,
    memberHumanId: "44444444-4444-4444-8444-444444444444",
    stripeSubscriptionId: "sub_1",
    stripeCustomerId: CUSTOMER_ID,
    status: "active",
    taxJurisdictionId: "old-jurisdiction",
    billingPostalCode: "37206",
    billingCountryCode: "US",
    currentPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
    canceledAt: null,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildJurisdiction(
  overrides: Partial<MembershipTaxJurisdictionRecord> = {},
): MembershipTaxJurisdictionRecord {
  return {
    id: JURISDICTION_ID,
    countryCode: "US",
    postalCode: "97202",
    rateBps: 0,
    rateSource: membershipRateSource("ziptax"),
    stripeTaxRateId: null,
    checkedAt: new Date("2026-08-10T00:00:00.000Z"),
    effectiveFrom: null,
    archivedAt: null,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

/** What the use case hands `memberships.updateBillingAddress`. */
type BillingAddressWrite = {
  id: string;
  taxJurisdictionId: string;
  billingPostalCode: string;
  billingCountryCode: string;
};

/** What the use case hands `MembershipBillingPort.updateSubscriptionTaxRates`. */
type StripeTaxRateUpdate = {
  subscriptionId: string;
  defaultTaxRateIds: string[];
  idempotencyKey: string;
};

function makeCtx(
  options: {
    memberships?: MembershipRecord[];
    /** Live cached jurisdiction row; null = cache miss. */
    cachedJurisdiction?: MembershipTaxJurisdictionRecord | null;
    /** ZipTax answer on a cache miss. Null = jurisdiction UNSUPPORTED. */
    lookup?: { rateBps: number; source: string } | null;
    lookupThrows?: boolean;
    idempotencyCached?: unknown;
  } = {},
) {
  const memberships = {
    listByStripeCustomerId: vi.fn(async () =>
      options.memberships ?? [buildMembership()],
    ),
    // Full arg type, not just `{id}`: tests assert the row is repointed at the
    // resolved jurisdiction, which is the DB half of the Stripe-first ordering.
    updateBillingAddress: vi.fn(async (input: BillingAddressWrite) =>
      buildMembership({ id: input.id }),
    ),
  };

  // No `membershipTiers` fake: this use case does not read the tier at all.
  // It only ever did so to fetch a tax category, and the jurisdiction key is
  // now (country, postal) — nothing on the tier can change the answer. If a
  // per-row tier read is ever reintroduced it will blow up on the missing
  // repo here, which is the intended alarm.

  const cached =
    options.cachedJurisdiction === undefined
      ? null
      : options.cachedJurisdiction;
  const membershipTaxJurisdictions = {
    // Typed arg on purpose: tests assert on the exact key shape passed in, so
    // an extra property sneaking back into the cache key is visible here.
    findLive: vi.fn(
      async (_key: { countryCode: string; postalCode: string }) => cached,
    ),
    create: vi.fn(
      async (input: Record<string, unknown>) =>
        buildJurisdiction(input as Partial<MembershipTaxJurisdictionRecord>),
    ),
    attachStripeTaxRateId: vi.fn(async (input: { id: string }) =>
      buildJurisdiction({ id: input.id, stripeTaxRateId: "txr_minted" }),
    ),
  };

  const taxRateLookup = {
    lookupByPostalCode: vi.fn(async () => {
      if (options.lookupThrows) throw new Error("ziptax_down");
      return options.lookup === undefined
        ? { rateBps: 700, source: "ziptax" }
        : options.lookup;
    }),
  };

  const billing = {
    ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_minted" })),
    // Typed arg: several tests read `mock.calls` to assert on the Stripe
    // idempotency KEY, which is the thing standing between a fan-out and a
    // silently-skipped subscription. An untyped fake makes those reads casts.
    updateSubscriptionTaxRates: vi.fn(async (_args: StripeTaxRateUpdate) => ({
      subscriptionId: "sub_1",
      status: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: null,
    })),
  };

  const idempotencyStore = new Map<string, unknown>();
  if (options.idempotencyCached) {
    idempotencyStore.set(
      `membership_billing_address:${EVENT_ID}`,
      options.idempotencyCached,
    );
  }
  const idempotency = {
    get: vi.fn(async (key: string) => idempotencyStore.get(key) ?? null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async (key: string, value: unknown) => {
      idempotencyStore.set(key, value);
    }),
    fail: vi.fn(async () => undefined),
    // Transient failures RELEASE the claim (owner-checked) rather than
    // parking a 15-minute `failed:` marker — see lib/idempotency-claim.
    release: vi.fn(async () => true),
  };

  const reportError = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  return {
    memberships,
    membershipTaxJurisdictions,
    taxRateLookup,
    billing,
    idempotency,
    reportError,
    logger,
    deps: {
      repos: {
        memberships,
        membershipTaxJurisdictions,
      } as unknown as Repos,
      membershipBilling: billing as never,
      taxRateLookup: taxRateLookup as never,
      idempotency: idempotency as never,
      clock: { now: () => new Date("2026-08-10T12:00:00.000Z") },
      logger: logger as never,
      reportError,
    },
  };
}

const baseInput = {
  stripeCustomerId: CUSTOMER_ID,
  billingCountryCode: "US",
  billingPostalCode: "97202",
  stripeEventId: EVENT_ID,
};

describe("updateMemberBillingAddress", () => {
  it("re-resolves from the CACHE and migrates the subscription — no ZipTax call", async () => {
    // The spec's acceptance criterion verbatim: "makes no ZipTax call when
    // the new postal code is already cached."
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith({
      subscriptionId: "sub_1",
      defaultTaxRateIds: ["txr_cached"],
      idempotencyKey: `membership-sub-tax:${EVENT_ID}:${MEMBERSHIP_ID}`,
    });
    expect(ctx.memberships.updateBillingAddress).toHaveBeenCalledWith({
      id: MEMBERSHIP_ID,
      taxJurisdictionId: JURISDICTION_ID,
      billingPostalCode: "97202",
      billingCountryCode: "US",
    });
    expect(result).toMatchObject({ ok: true, updated: 1, unpriceable: 0 });
  });

  it("A→B→A inside Stripe's 24h key retention: the return move mints a DIFFERENT key than the original", async () => {
    // The bug this pins: a key on (membership, jurisdiction) is IDENTICAL for
    // the first move to a jurisdiction and a later move BACK to it. Stripe
    // retains idempotency keys for ~24h, so the return move would replay the
    // cached original response without touching the subscription — Stripe
    // keeps billing the intermediate address while our row says otherwise.
    // Event-scoped keys make every distinct event a distinct Stripe call.
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });
    // Stateful row: the fan-out reflects prior address writes, so the third
    // event is a REAL change back to a previously-billed jurisdiction.
    let row = buildMembership(); // starts at 37206
    ctx.memberships.listByStripeCustomerId.mockImplementation(async () => [
      row,
    ]);
    ctx.memberships.updateBillingAddress.mockImplementation(
      async (write: BillingAddressWrite) => {
        row = {
          ...row,
          taxJurisdictionId: write.taxJurisdictionId,
          billingPostalCode: write.billingPostalCode,
          billingCountryCode: write.billingCountryCode,
        };
        return row;
      },
    );

    const move = (postal: string, eventId: string) =>
      updateMemberBillingAddress(ctx.deps, {
        ...baseInput,
        billingPostalCode: postal,
        stripeEventId: eventId,
      });

    await move("97202", "evt_move_1"); // A → B
    await move("37206", "evt_move_2"); // B → A
    await move("97202", "evt_move_3"); // A → B again — same (membership, jurisdiction) as evt_move_1

    const keys = ctx.billing.updateSubscriptionTaxRates.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(`membership-sub-tax:evt_move_1:${MEMBERSHIP_ID}`);
    expect(keys[2]).toBe(`membership-sub-tax:evt_move_3:${MEMBERSHIP_ID}`);
    // The load-bearing assertion: the return move's Stripe call cannot be
    // swallowed by the original's cached idempotent response.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("calls ZipTax exactly ONCE on a cache miss and caches the answer", async () => {
    const ctx = makeCtx({ cachedJurisdiction: null });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(ctx.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(ctx.membershipTaxJurisdictions.create).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });

  it("does NOTHING when every row already has the new address — the hot path", async () => {
    const ctx = makeCtx({
      memberships: [
        buildMembership({ billingPostalCode: "97202" }),
        buildMembership({
          id: MEMBERSHIP_ID_2,
          tierId: TIER_ID_2,
          stripeSubscriptionId: "sub_2",
          // Case-insensitive: startMembership stores as typed.
          billingPostalCode: "97202",
          billingCountryCode: "us",
        }),
      ],
    });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
    expect(ctx.memberships.updateBillingAddress).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, updated: 0, unchanged: 2 });
  });

  it("fans out to EVERY membership on the customer — one card, many owners", async () => {
    // Two memberships on two different tiers, one Stripe Customer. The tiers
    // are incidental to the TAX here — every row resolves the SAME (country,
    // postal) jurisdiction — and that is precisely the point worth pinning:
    // the loop is not a per-row tax lookup, it is a per-row STRIPE
    // SUBSCRIPTION migration. Each membership owns its own subscription id,
    // so each one's `default_tax_rates` has to be repointed individually or
    // one of them keeps billing the old jurisdiction's rate.
    const ctx = makeCtx({
      memberships: [
        buildMembership(),
        buildMembership({
          id: MEMBERSHIP_ID_2,
          tierId: TIER_ID_2,
          stripeSubscriptionId: "sub_2",
        }),
      ],
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(result).toMatchObject({ ok: true, memberships: 2, updated: 2 });
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledTimes(2);
    const calls = ctx.billing.updateSubscriptionTaxRates.mock.calls.map(
      (c) => c[0],
    );
    expect(calls.map((c) => c.subscriptionId)).toEqual(["sub_1", "sub_2"]);
    expect(ctx.memberships.updateBillingAddress).toHaveBeenCalledTimes(2);

    // The bug this pins: both Stripe calls happen under ONE webhook event, so
    // a key scoped to the event alone would make the second call replay the
    // first's cached idempotent response — sub_2 silently never repointed,
    // while our row for it claims the new address. The key must carry the
    // MEMBERSHIP id too.
    const keys = calls.map((c) => c.idempotencyKey);
    expect(keys).toEqual([
      `membership-sub-tax:${EVENT_ID}:${MEMBERSHIP_ID}`,
      `membership-sub-tax:${EVENT_ID}:${MEMBERSHIP_ID_2}`,
    ]);
    expect(new Set(keys).size).toBe(2);

    // One jurisdiction for the whole fan-out, keyed on the PLACE only — the
    // second row is a pure cache hit, so N memberships cost at most one
    // provider call no matter how many tiers are involved.
    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    for (const call of ctx.membershipTaxJurisdictions.findLive.mock.calls) {
      expect(call[0]).toEqual({ countryCode: "US", postalCode: "97202" });
    }
    const writes = ctx.memberships.updateBillingAddress.mock.calls.map(
      (c) => c[0],
    );
    expect(writes.map((w) => w.taxJurisdictionId)).toEqual([
      JURISDICTION_ID,
      JURISDICTION_ID,
    ]);
  });

  it("CLEARS the subscription's rates for a genuine 0% jurisdiction", async () => {
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({ rateBps: 0 }),
    });

    await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTaxRateIds: [] }),
    );
  });

  it("mints the Stripe TaxRate lazily when the cached jurisdiction has none", async () => {
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: null,
      }),
    });

    await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(ctx.billing.ensureTaxRate).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionId: JURISDICTION_ID,
        percentage: 7,
        inclusive: false,
        idempotencyKey: `membership-tax-rate:${JURISDICTION_ID}`,
      }),
    );
    expect(
      ctx.membershipTaxJurisdictions.attachStripeTaxRateId,
    ).toHaveBeenCalledWith({
      id: JURISDICTION_ID,
      stripeTaxRateId: "txr_minted",
    });
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith(
      expect.objectContaining({ defaultTaxRateIds: ["txr_minted"] }),
    );
  });

  it("UNPRICEABLE move (provider does not cover it): keeps the last known-good rate, reports, does not throw", async () => {
    // Fail-OPEN, the opposite of signup: an existing member moving somewhere
    // unpriceable must not have a live membership silently killed or zeroed.
    const ctx = makeCtx({ cachedJurisdiction: null, lookup: null });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(result).toMatchObject({ ok: true, updated: 0, unpriceable: 1 });
    // Rate untouched: no Stripe migration, no row write, nothing cached.
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
    expect(ctx.memberships.updateBillingAddress).not.toHaveBeenCalled();
    expect(ctx.membershipTaxJurisdictions.create).not.toHaveBeenCalled();
    // Ops-visible: warn alone is NOT Sentry-captured, the report is the signal.
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TAX_JURISDICTION_UNSUPPORTED" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "updateMemberBillingAddress",
        }),
      }),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "membership.billing_address.unpriceable_move",
      expect.objectContaining({ code: "TAX_JURISDICTION_UNSUPPORTED" }),
    );
  });

  it("provider OUTAGE: same fail-open posture, reported once by THIS use case", async () => {
    const ctx = makeCtx({ cachedJurisdiction: null, lookupThrows: true });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(result).toMatchObject({ ok: true, unpriceable: 1 });
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
    // Exactly one report — reportError is deliberately NOT forwarded into the
    // nested resolveMemberTaxJurisdiction, or UNAVAILABLE would report twice.
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "TAX_JURISDICTION_UNAVAILABLE" }),
      expect.anything(),
    );
  });

  it("skips rows that are not LIVE — a dead subscription cannot be updated", async () => {
    const ctx = makeCtx({
      memberships: [
        buildMembership({ status: "canceled" }),
        buildMembership({
          id: MEMBERSHIP_ID_2,
          stripeSubscriptionId: "sub_2",
          status: "active",
        }),
      ],
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(result).toMatchObject({ updated: 1, skippedNotLive: 1 });
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledTimes(1);
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "sub_2" }),
    );
  });

  it("REPLAY is idempotent: the stored response returns, nothing re-runs", async () => {
    const stored = {
      response: {
        ok: true,
        memberships: 1,
        updated: 1,
        unchanged: 0,
        skippedNotLive: 0,
        unpriceable: 0,
      },
      stripeCustomerId: CUSTOMER_ID,
    };
    const ctx = makeCtx({ idempotencyCached: stored });

    const result = await updateMemberBillingAddress(ctx.deps, baseInput);

    expect(result).toEqual(stored.response);
    expect(ctx.memberships.listByStripeCustomerId).not.toHaveBeenCalled();
    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
  });

  it("refuses an event id replayed with a DIFFERENT customer", async () => {
    const ctx = makeCtx({
      idempotencyCached: {
        response: {
          ok: true,
          memberships: 1,
          updated: 1,
          unchanged: 0,
          skippedNotLive: 0,
          unpriceable: 0,
        },
        stripeCustomerId: "cus_other",
      },
    });

    await expect(
      updateMemberBillingAddress(ctx.deps, baseInput),
    ).rejects.toMatchObject({ code: "STRIPE_EVENT_CONFLICT" });
  });

  it("a Stripe write failure THROWS (retryable via the DLQ) and fails the idempotency claim", async () => {
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });
    ctx.billing.updateSubscriptionTaxRates.mockRejectedValueOnce(
      new Error("stripe_down"),
    );

    await expect(
      updateMemberBillingAddress(ctx.deps, baseInput),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    // The row was NOT written — Stripe-first ordering means the replay
    // still sees the old address and retries the whole row.
    expect(ctx.memberships.updateBillingAddress).not.toHaveBeenCalled();
    // A Stripe outage is transient: the claim is RELEASED so the DLQ replay
    // (or Stripe's own retry) can proceed at once, not refused for 15 min.
    expect(ctx.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.idempotency.fail).not.toHaveBeenCalled();
    expect(ctx.idempotency.commit).not.toHaveBeenCalled();
  });

  it("a row write failure after the Stripe update also THROWS", async () => {
    const ctx = makeCtx({
      cachedJurisdiction: buildJurisdiction({
        rateBps: 700,
        stripeTaxRateId: "txr_cached",
      }),
    });
    ctx.memberships.updateBillingAddress.mockRejectedValueOnce(
      new Error("db_unavailable"),
    );

    await expect(
      updateMemberBillingAddress(ctx.deps, baseInput),
    ).rejects.toMatchObject({ code: "dependency_failed" });
    expect(ctx.idempotency.release).toHaveBeenCalledTimes(1);
    expect(ctx.idempotency.fail).not.toHaveBeenCalled();
  });
});
