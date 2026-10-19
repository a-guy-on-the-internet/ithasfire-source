import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { MembershipTaxJurisdictionRecord } from "@th/ports/repos/membership-tax-jurisdictions";

import { refreshTaxJurisdictions } from "../refresh-tax-jurisdictions";
import {
  membershipRateSource,
  resolveMemberTaxJurisdiction,
} from "../resolve-member-tax-jurisdiction";

const NOW = new Date("2026-08-10T12:00:00.000Z");

describe("resolveMemberTaxJurisdiction", () => {
  it("returns the cached row without calling the provider", async () => {
    const ctx = makeCtx({ live: buildJurisdiction() });

    const result = await resolveMemberTaxJurisdiction(ctx.deps, key());

    expect(result.lookedUp).toBe(false);
    expect(result.jurisdiction.rateBps).toBe(975);
    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it("looks up and caches on a miss, then serves the next member from cache", async () => {
    const ctx = makeCtx();
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 925,
      source: "ziptax",
    });

    const first = await resolveMemberTaxJurisdiction(ctx.deps, key());
    expect(first.lookedUp).toBe(true);
    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: "US",
        postalCode: "37206",
        rateBps: 925,
        rateSource: membershipRateSource("ziptax"),
      }),
    );

    // The whole point of caching on the PLACE rather than the person: the
    // second member in this postal code costs no provider call. There is no
    // per-category dimension to fork that cache, so this holds for every
    // member in the ZIP regardless of which tier they bought.
    const second = await resolveMemberTaxJurisdiction(ctx.deps, key());
    expect(second.lookedUp).toBe(false);
    expect(ctx.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("normalises the key so casing and whitespace cannot fork the cache", async () => {
    const ctx = makeCtx();
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 925,
      source: "ziptax",
    });

    await resolveMemberTaxJurisdiction(ctx.deps, {
      countryCode: "us",
      postalCode: " 37206 ",
    });

    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: "US", postalCode: "37206" }),
    );
  });

  it("REJECTS a taxCategory instead of quietly ignoring it", async () => {
    // The key is (country, postal) and nothing else. The schema is `.strict()`
    // so a caller still passing the removed `taxCategory` fails loudly at the
    // boundary rather than having it stripped — a silent strip would let a
    // caller believe it had asked for a category-specific rate and been given
    // one, when the answer is always the postal code's GENERAL rate. If a
    // provider that resolves by category ever arrives, the port signature
    // changes first and this test is what forces the key to follow.
    const ctx = makeCtx();

    await expect(
      resolveMemberTaxJurisdiction(ctx.deps, {
        countryCode: "US",
        postalCode: "37206",
        taxCategory: "ADMISSION",
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ code: "unrecognized_keys" })],
    });

    expect(ctx.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it("REFUSES rather than guessing when the provider is down, and reports it", async () => {
    const ctx = makeCtx();
    const lookupError = new Error("ziptax 503");
    ctx.taxRateLookup.lookupByPostalCode.mockRejectedValue(lookupError);

    // Unlike ticketing, which degrades to 0 rather than block a checkout: we
    // are merchant of record, so uncollected tax is tax WE owe, and a
    // membership re-bills every period. Refusing beats compounding a liability.
    await expect(
      resolveMemberTaxJurisdiction(ctx.deps, key()),
    ).rejects.toMatchObject({ code: "TAX_JURISDICTION_UNAVAILABLE" });

    expect(ctx.reportError).toHaveBeenCalledWith(
      lookupError,
      expect.objectContaining({
        tags: { useCase: "resolveMemberTaxJurisdiction" },
      }),
    );
    // Nothing unpriceable is ever written.
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it("refuses a jurisdiction the provider does not cover, WITHOUT reporting", async () => {
    const ctx = makeCtx();
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue(null);

    await expect(
      resolveMemberTaxJurisdiction(ctx.deps, {
        countryCode: "CA",
        postalCode: "T5J2R7",
      }),
    ).rejects.toMatchObject({ code: "TAX_JURISDICTION_UNSUPPORTED" });

    // A normal business rejection, not an incident. ZipTax is US-only, so
    // Sentry would otherwise fill with every non-US signup attempt and bury
    // the outages that matter.
    expect(ctx.reportError).not.toHaveBeenCalled();
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it("treats a genuine 0% jurisdiction as a real answer, not a failure", async () => {
    const ctx = makeCtx();
    // Delaware, Montana, New Hampshire and Oregon levy no state sales tax.
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 0,
      source: "ziptax",
    });

    const result = await resolveMemberTaxJurisdiction(ctx.deps, {
      countryCode: "US",
      postalCode: "97201",
    });

    expect(result.jurisdiction.rateBps).toBe(0);
    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rateBps: 0,
        rateSource: membershipRateSource("ziptax"),
      }),
    );
  });

  it("stamps the provider source with the `:general` suffix", async () => {
    // NOTHING BRANCHES ON rateSource — no code path reads it, so this test is
    // not protecting behaviour. It exists because the column's only consumer
    // is a HUMAN reading a cached rate months later and asking "what was this
    // a rate FOR?". Memberships bill the postal code's general rate; we make
    // no digital-goods-vs-admissions determination, and a bare "ziptax" would
    // let that row be mistaken for one. The suffix is the row saying so out
    // loud, and this pins that it survives — an un-suffixed row is a silent
    // documentation regression no other assertion would catch.
    const ctx = makeCtx();
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 925,
      source: "ziptax",
    });

    await resolveMemberTaxJurisdiction(ctx.deps, key());

    // Asserted against the literal, NOT the helper: this one test has to fail
    // if the helper's own suffix changes, which an assertion built from the
    // helper could never do. Every OTHER rateSource assertion in this file
    // goes through `membershipRateSource` so the two write sites cannot drift.
    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ rateSource: "ziptax:general" }),
    );
    expect(membershipRateSource("ziptax")).toBe("ziptax:general");
  });
});

describe("refreshTaxJurisdictions", () => {
  it("only touches checkedAt when the rate is unchanged", async () => {
    const ctx = makeCtx({ stale: [buildJurisdiction({ rateBps: 975 })] });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 975,
      source: "ziptax",
    });

    const result = await refreshTaxJurisdictions(ctx.deps);

    expect(result).toMatchObject({ examined: 1, unchanged: 1, changed: 0 });
    expect(ctx.repo.touchCheckedAt).toHaveBeenCalledWith({
      id: "jur_1",
      checkedAt: NOW,
    });
    expect(ctx.repo.archive).not.toHaveBeenCalled();
    expect(ctx.repo.create).not.toHaveBeenCalled();
  });

  it("archives, replaces and repoints memberships when the rate changed", async () => {
    const ctx = makeCtx({ stale: [buildJurisdiction({ rateBps: 975 })] });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 1000,
      source: "ziptax",
    });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 1000 }),
    );
    ctx.repo.migrateMemberships.mockResolvedValue({ migratedCount: 42 });

    const result = await refreshTaxJurisdictions(ctx.deps);

    // Archive must land before the insert: the partial unique index permits
    // only one LIVE row per (country, postal).
    expect(ctx.repo.archive).toHaveBeenCalledWith({
      id: "jur_1",
      archivedAt: NOW,
    });
    expect(ctx.repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rateBps: 1000,
        effectiveFrom: NOW,
        // The SECOND write site. An archived row and its replacement must not
        // read as two different kinds of rate when only the number moved, so
        // both stamp provenance through the same helper.
        rateSource: membershipRateSource("ziptax"),
      }),
    );
    expect(ctx.repo.migrateMemberships).toHaveBeenCalledWith({
      fromJurisdictionId: "jur_1",
      toJurisdictionId: "jur_2",
    });
    expect(result).toMatchObject({
      changed: 1,
      membershipsMigrated: 42,
    });
    // No LIVE membership references the old row here, so Stripe is never
    // touched: no TaxRate mint, no subscription update.
    expect(ctx.billing.ensureTaxRate).not.toHaveBeenCalled();
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
  });

  it("SPEC AC: a rate change with NO member-initiated event migrates every LIVE subscription off the archived rate", async () => {
    const ctx = makeCtx({
      stale: [buildJurisdiction({ rateBps: 975 })],
      liveMemberships: [
        buildMembership("mem_1", "sub_live_1"),
        buildMembership("mem_2", "sub_live_2"),
      ],
    });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 1000,
      source: "ziptax",
    });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 1000 }),
    );
    ctx.repo.migrateMemberships.mockResolvedValue({ migratedCount: 3 });

    const result = await refreshTaxJurisdictions(ctx.deps);

    // Live set read from the OLD jurisdiction — necessarily BEFORE
    // migrateMemberships repoints the rows — filtered to LIVE statuses, so
    // lapsed subscriptions (nothing bills) never reach Stripe.
    expect(ctx.memberships.listByTaxJurisdictionId).toHaveBeenCalledWith({
      taxJurisdictionId: "jur_1",
      statuses: ["active", "trialing", "past_due", "unpaid"],
    });
    // The replacement's TaxRate is minted (old row archived above; Stripe
    // percentages are immutable, so this is Stripe's archive-and-replace).
    expect(ctx.billing.ensureTaxRate).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdictionId: "jur_2",
        percentage: 10,
        idempotencyKey: "membership-tax-rate:jur_2",
      }),
    );
    expect(ctx.repo.attachStripeTaxRateId).toHaveBeenCalledWith({
      id: "jur_2",
      stripeTaxRateId: "txr_new",
    });
    // ...and EVERY live subscription is repointed at it. The key is scoped
    // to (replacement, membership): the replacement id is unique per rate
    // change, so a re-run of the same refresh replays safely and a later
    // change mints a fresh key.
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledTimes(2);
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith({
      subscriptionId: "sub_live_1",
      defaultTaxRateIds: ["txr_new"],
      idempotencyKey: "refresh-sub-tax:jur_2:mem_1",
    });
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith({
      subscriptionId: "sub_live_2",
      defaultTaxRateIds: ["txr_new"],
      idempotencyKey: "refresh-sub-tax:jur_2:mem_2",
    });
    expect(result).toMatchObject({
      changed: 1,
      subscriptionsMigrated: 2,
      subscriptionMigrationFailures: [],
    });
  });

  it("a jurisdiction dropping to a genuine 0% CLEARS live subscriptions' rates without minting", async () => {
    const ctx = makeCtx({
      stale: [buildJurisdiction({ rateBps: 975 })],
      liveMemberships: [buildMembership("mem_1", "sub_live_1")],
    });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 0,
      source: "ziptax",
    });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 0 }),
    );

    const result = await refreshTaxJurisdictions(ctx.deps);

    // 0% needs no TaxRate; the empty list must still be SENT — the port
    // contract clears previously-set rates rather than no-opping.
    expect(ctx.billing.ensureTaxRate).not.toHaveBeenCalled();
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub_live_1",
        defaultTaxRateIds: [],
      }),
    );
    expect(result.subscriptionsMigrated).toBe(1);
  });

  it("a per-subscription Stripe failure is reported, collected, and does NOT strand the rest", async () => {
    const ctx = makeCtx({
      stale: [buildJurisdiction({ rateBps: 975 })],
      liveMemberships: [
        buildMembership("mem_1", "sub_live_1"),
        buildMembership("mem_2", "sub_live_2"),
      ],
    });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 1000,
      source: "ziptax",
    });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 1000 }),
    );
    const boom = new Error("stripe 500");
    ctx.billing.updateSubscriptionTaxRates.mockRejectedValueOnce(boom);

    const result = await refreshTaxJurisdictions(ctx.deps);

    // The second subscription still migrated.
    expect(ctx.billing.updateSubscriptionTaxRates).toHaveBeenCalledTimes(2);
    expect(result.subscriptionsMigrated).toBe(1);
    // The failure is collected for remediation — the DB row already points
    // at the replacement and the old row is archived, so nothing retries it.
    expect(result.subscriptionMigrationFailures).toEqual([
      { membershipId: "mem_1", stripeSubscriptionId: "sub_live_1" },
    ]);
    // ...and reported (warn/log alone is not Sentry-visible).
    expect(ctx.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "refreshTaxJurisdictions",
          step: "updateSubscriptionTaxRates",
        }),
      }),
    );
  });

  it("a TaxRate mint failure marks every live subscription failed and keeps the batch going", async () => {
    const ctx = makeCtx({
      stale: [
        buildJurisdiction({ id: "jur_1", rateBps: 975 }),
        buildJurisdiction({ id: "jur_other", postalCode: "37207" }),
      ],
      liveMemberships: [
        buildMembership("mem_1", "sub_live_1"),
        buildMembership("mem_2", "sub_live_2"),
      ],
    });
    ctx.taxRateLookup.lookupByPostalCode
      .mockResolvedValueOnce({ rateBps: 1000, source: "ziptax" })
      .mockResolvedValueOnce({ rateBps: 975, source: "ziptax" });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 1000 }),
    );
    const mintBoom = new Error("stripe tax_rates 500");
    ctx.billing.ensureTaxRate.mockRejectedValue(mintBoom);

    const result = await refreshTaxJurisdictions(ctx.deps);

    // No subscription update was attempted without a rate to point at.
    expect(ctx.billing.updateSubscriptionTaxRates).not.toHaveBeenCalled();
    expect(result.subscriptionMigrationFailures).toEqual([
      { membershipId: "mem_1", stripeSubscriptionId: "sub_live_1" },
      { membershipId: "mem_2", stripeSubscriptionId: "sub_live_2" },
    ]);
    expect(ctx.reportError).toHaveBeenCalledWith(
      mintBoom,
      expect.objectContaining({
        tags: expect.objectContaining({ step: "ensureTaxRate" }),
      }),
    );
    // The second (unchanged) jurisdiction was still examined.
    expect(result).toMatchObject({ examined: 2, unchanged: 1, changed: 1 });
  });

  it("catches a rate change with NO member-side event at all", async () => {
    // The reason this job exists. Nothing about the member changed — no new
    // address, no tier edit, no signup. Only the jurisdiction moved.
    const ctx = makeCtx({ stale: [buildJurisdiction({ rateBps: 975 })] });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 1025,
      source: "ziptax",
    });
    ctx.repo.create.mockResolvedValue(
      buildJurisdiction({ id: "jur_2", rateBps: 1025 }),
    );

    const result = await refreshTaxJurisdictions(ctx.deps);

    expect(result.changed).toBe(1);
  });

  it("does NOT treat an unknown rate as zero", async () => {
    const ctx = makeCtx({ stale: [buildJurisdiction({ rateBps: 975 })] });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue(null);

    const result = await refreshTaxJurisdictions(ctx.deps);

    // "I don't know" is not evidence the jurisdiction stopped taxing. Zeroing
    // a live rate on a provider gap would under-collect silently.
    expect(result).toMatchObject({ failed: 1, changed: 0, unchanged: 0 });
    expect(ctx.repo.archive).not.toHaveBeenCalled();
    expect(ctx.repo.touchCheckedAt).not.toHaveBeenCalled();
  });

  it("reports a failure and keeps going through the rest of the batch", async () => {
    const ctx = makeCtx({
      stale: [
        buildJurisdiction({ id: "jur_1" }),
        buildJurisdiction({ id: "jur_2", postalCode: "37207" }),
      ],
    });
    const boom = new Error("ziptax 500");
    ctx.taxRateLookup.lookupByPostalCode
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce({ rateBps: 975, source: "ziptax" });

    const result = await refreshTaxJurisdictions(ctx.deps);

    expect(result).toMatchObject({ examined: 2, failed: 1, unchanged: 1 });
    expect(ctx.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "refreshTaxJurisdictions" },
      }),
    );
  });

  it("flags truncation so a full batch is never mistaken for full coverage", async () => {
    const ctx = makeCtx({ stale: [buildJurisdiction()] });
    ctx.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 975,
      source: "ziptax",
    });

    const result = await refreshTaxJurisdictions(ctx.deps, { limit: 1 });

    expect(result.truncated).toBe(true);
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

/** The whole cache key: a place, and nothing about what was sold. */
function key() {
  return { countryCode: "US", postalCode: "37206" };
}

function buildJurisdiction(
  overrides: Partial<MembershipTaxJurisdictionRecord> = {},
): MembershipTaxJurisdictionRecord {
  return {
    id: "jur_1",
    countryCode: "US",
    postalCode: "37206",
    rateBps: 975,
    rateSource: membershipRateSource("ziptax"),
    stripeTaxRateId: null,
    checkedAt: new Date("2026-01-01T00:00:00.000Z"),
    effectiveFrom: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** Minimal live-membership shape the refresh migration consumes. */
function buildMembership(id: string, stripeSubscriptionId: string) {
  return {
    id,
    stripeSubscriptionId,
    status: "active",
    taxJurisdictionId: "jur_1",
  };
}

function makeCtx(
  options: {
    live?: MembershipTaxJurisdictionRecord | null;
    stale?: MembershipTaxJurisdictionRecord[];
    /** What listByTaxJurisdictionId returns (already status-filtered). */
    liveMemberships?: Array<ReturnType<typeof buildMembership>>;
  } = {},
) {
  // findLive starts from the seeded row (if any) and then reflects whatever
  // create() wrote, so the cache-hit-on-second-call assertion is real rather
  // than stubbed.
  let live = options.live ?? null;

  const repo = {
    findLive: vi.fn(async () => live),
    findById: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, unknown>) => {
      const created = buildJurisdiction(
        input as Partial<MembershipTaxJurisdictionRecord>,
      );
      live = created;
      return created;
    }),
    listStale: vi.fn(async () => options.stale ?? []),
    archive: vi.fn(async () => buildJurisdiction({ archivedAt: NOW })),
    touchCheckedAt: vi.fn(async () => buildJurisdiction({ checkedAt: NOW })),
    attachStripeTaxRateId: vi.fn(async () => buildJurisdiction()),
    migrateMemberships: vi.fn(async () => ({ migratedCount: 0 })),
  };

  const memberships = {
    listByTaxJurisdictionId: vi.fn(async () => options.liveMemberships ?? []),
  };

  const billing = {
    ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_new" })),
    updateSubscriptionTaxRates: vi.fn(async () => ({
      subscriptionId: "sub_x",
      status: "active",
      currentPeriodStart: NOW,
      currentPeriodEnd: NOW,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      paymentIntentClientSecret: null,
    })),
  };

  const taxRateLookup = {
    // Return type spelled out, not inferred from the `null` default: without
    // it every `mockResolvedValue({rateBps, source})` below is a type error,
    // because TS would narrow the fake to `() => Promise<null>`.
    lookupByPostalCode: vi.fn(
      async (): Promise<{ rateBps: number; source: string } | null> => null,
    ),
  };
  const reportError = vi.fn();
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

  return {
    repo,
    memberships,
    billing,
    taxRateLookup,
    reportError,
    logger,
    deps: {
      repos: {
        membershipTaxJurisdictions: repo,
        memberships,
      } as unknown as Repos,
      membershipBilling: billing as never,
      taxRateLookup: taxRateLookup as never,
      clock: { now: () => NOW },
      // Partial stub — LoggerPort also carries child/withTime/log, none of
      // which these use cases touch.
      logger: logger as never,
      reportError,
    },
  };
}
