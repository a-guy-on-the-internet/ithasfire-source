import { describe, expect, it, vi } from "vitest";

import { refreshMembershipTaxJurisdictions } from "../jobs/memberships";

/**
 * The job is a thin wrapper over the `refreshTaxJurisdictions` use case, whose
 * archive/replace/repoint behaviour is covered in
 * `packages/core/src/use-cases/memberships/__tests__/tax-jurisdictions.test.ts`.
 *
 * What is covered HERE is the wiring the use case cannot see: the
 * unconfigured-provider skip, and the truncation warning.
 */

const NOW = new Date("2026-08-10T06:40:00.000Z");

function makeCtx(
  options: {
    taxRateLookup?: unknown;
    membershipBilling?: unknown;
    stale?: Array<Record<string, unknown>>;
  } = {},
) {
  const logger = {
    child: () => logger,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTime: vi.fn(async (_l: string, fn: () => Promise<unknown>) => fn()),
  };

  const stale = options.stale ?? [];
  const repo = {
    findLive: vi.fn(async () => null),
    findById: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "jur_new" })),
    listStale: vi.fn(async () => stale),
    archive: vi.fn(async () => ({ id: "jur_1" })),
    touchCheckedAt: vi.fn(async () => ({ id: "jur_1" })),
    attachStripeTaxRateId: vi.fn(async () => ({ id: "jur_1" })),
    migrateMemberships: vi.fn(async () => ({ migratedCount: 0 })),
  };

  return {
    logger,
    repo,
    ctx: {
      repos: { membershipTaxJurisdictions: repo },
      taxRateLookup:
        options.taxRateLookup === undefined
          ? { lookupByPostalCode: vi.fn(async () => ({ rateBps: 975, source: "ziptax" })) }
          : options.taxRateLookup,
      // REQUIRED by the job: without it a rate change would archive our row
      // while the live Stripe subscription kept billing the old TaxRate.
      membershipBilling:
        options.membershipBilling === undefined
          ? {
              ensureTaxRate: vi.fn(async () => ({ taxRateId: "txr_new" })),
              updateSubscriptionTaxRates: vi.fn(async () => undefined),
            }
          : options.membershipBilling,
      clock: { now: () => NOW },
      logger,
      reportError: vi.fn(),
    },
  };
}

const run = async (ctx: unknown, input: Record<string, unknown> = {}) =>
  (await refreshMembershipTaxJurisdictions.handler({
    input: input as never,
    ctx: ctx as never,
  })) as Record<string, unknown>;

describe("memberships.refresh-tax-jurisdictions", () => {
  it("SKIPS when the rate provider is unconfigured, without touching any row", async () => {
    const { ctx, repo, logger } = makeCtx({ taxRateLookup: null });

    const result = await run(ctx);

    // An absent provider is not evidence that every jurisdiction stopped
    // taxing. Skipping preserves the last known-good rates; anything else
    // risks archiving live rates wholesale on a config mistake.
    expect(result).toEqual({
      skipped: true,
      reason: "ziptax_not_configured",
    });
    expect(repo.listStale).not.toHaveBeenCalled();
    expect(repo.archive).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "memberships.refresh_tax_jurisdictions.skipped",
      { reason: "ziptax_not_configured" },
    );
    // warn is not Sentry-captured, so a missing key would otherwise be a
    // permanent silent no-op with every rate frozen and nothing saying so.
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "membership_tax_refresh_ziptax_not_configured",
      }),
      { tags: { area: "membership-tax" } },
    );
  });

  it("THROWS — never skips — when billing is unconfigured, so no row is archived", async () => {
    const { ctx, repo } = makeCtx({ membershipBilling: null });

    // Deliberately the opposite posture to the ZipTax skip above. Missing
    // rates means "we learned nothing, leave everything alone" — safe. Missing
    // BILLING means we could archive a jurisdiction and repoint our own rows
    // while every live Stripe subscription kept billing the archived TaxRate
    // forever. Failing loudly is the only safe response for a scheduled job.
    await expect(run(ctx)).rejects.toThrow(
      /membership_tax_refresh_billing_not_configured/,
    );
    expect(repo.listStale).not.toHaveBeenCalled();
    expect(repo.archive).not.toHaveBeenCalled();
  });

  it("runs the refresh and reports counts when configured", async () => {
    const { ctx } = makeCtx();

    const result = await run(ctx);

    expect(result).toMatchObject({ skipped: false, examined: 0 });
  });

  it("passes the staleness window and batch cap through", async () => {
    const { ctx, repo } = makeCtx();

    await run(ctx, { maxAgeDays: 30, limit: 5 });

    expect(repo.listStale).toHaveBeenCalledWith({
      staleBefore: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
      limit: 5,
    });
  });

  it("defaults to a 7-day window, not a quarterly one", async () => {
    const { ctx, repo } = makeCtx();

    await run(ctx);

    // A 90-day window would let a row checked in mid-December go unexamined
    // until mid-March — ten weeks of billing past a 1 January rate change.
    expect(repo.listStale).toHaveBeenCalledWith(
      expect.objectContaining({
        staleBefore: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
      }),
    );
  });

  it("warns on truncation so a full batch is not mistaken for full coverage", async () => {
    const { ctx, logger } = makeCtx({
      stale: [
        {
          id: "jur_1",
          countryCode: "US",
          postalCode: "37206",
          rateBps: 975,
        },
      ],
    });

    const result = await run(ctx, { limit: 1 });

    expect(result.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "memberships.refresh_tax_jurisdictions.truncated",
      { examined: 1 },
    );
  });
});
