/**
 * tax.fill-location-rate
 *
 * The jobs half of the background venue tax-rate fill: Cloud Tasks POSTs
 * `{ target }` (queued by a listing that found a venue with no cached rate),
 * the handler looks the rate up and fills the cache. A FAILED lookup must
 * THROW — app.ts answers 200 for any returned value, and only a non-2xx makes
 * Cloud Tasks retry — and is reported (jobs has no pino → Sentry path).
 */
import { describe, expect, it, vi } from "vitest";

import { TAX_RATE_FILL_JOB } from "@th/core/use-cases/tax/tax-rate-fill-queue";
import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";

import manifest from "../../jobs.manifest.json";

const { fillLocationTaxRateJob, taxJobs } = await import("../jobs/tax");
const { REGISTERED_JOBS } = await import("../jobs/registry.generated");

const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-06T12:00:00.000Z");

function makeCtx(lookup: () => Promise<unknown>) {
  const repos = {
    events: {
      listUnstampedUpcomingIdsAtTaxLocation: vi.fn(async () => ["e-1"]),
    },
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        addressLine1: "600 N 1st Ave",
        city: "Minneapolis",
        region: "MN",
        postalCode: "55403",
        countryCode: "US",
        admissionTaxRateBps: null,
        taxRateSource: null,
      })),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    savedLocations: { getById: vi.fn(async () => null) },
    searchReindexPending: { mark: vi.fn(async () => undefined) },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos)),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
  };
  return {
    repos,
    taxRateLookup: { lookupByPostalCode: vi.fn(lookup) },
    clock: { now: () => NOW },
    logger,
    reportError: vi.fn(),
  };
}

const input = { target: { kind: "place" as const, placeId: PLACE_ID } };

describe("tax.fill-location-rate", () => {
  it("is the job core queues, registered and in the manifest", () => {
    expect(fillLocationTaxRateJob.name).toBe(TAX_RATE_FILL_JOB);
    expect(taxJobs).toContain(fillLocationTaxRateJob);
    expect(REGISTERED_JOBS.some((j) => j.name === TAX_RATE_FILL_JOB)).toBe(true);
    expect(
      (manifest as { queue: Record<string, unknown> }).queue[TAX_RATE_FILL_JOB],
    ).toBeDefined();
  });

  it("fills the venue cache and marks its events", async () => {
    const ctx = makeCtx(async () => ({ rateBps: 903, source: "ziptax" }));
    const out = await fillLocationTaxRateJob.handler({
      input,
      ctx: ctx as never,
    });
    expect(out).toMatchObject({
      success: true,
      result: { status: "filled", reindexedEventCount: 1 },
    });
    expect(ctx.repos.places.fillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    expect(ctx.reportError).not.toHaveBeenCalled();
  });

  it("a FAILED lookup throws (Cloud Tasks retries) and is reported", async () => {
    const ctx = makeCtx(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", { providerCode: 108 });
    });
    await expect(
      fillLocationTaxRateJob.handler({ input, ctx: ctx as never }),
    ).rejects.toMatchObject({ providerCode: 108 });
    expect(ctx.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ providerCode: 108 }),
      expect.objectContaining({ tags: { job: "tax.fill-location-rate" } }),
    );
    expect(ctx.repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("two failures inside the window report once, and both still throw", async () => {
    const ctx = makeCtx(async () => {
      throw new TaxRateLookupError("Ziptax rCode 108", { providerCode: 108 });
    });
    for (let n = 0; n < 2; n++) {
      await expect(
        fillLocationTaxRateJob.handler({ input, ctx: ctx as never }),
      ).rejects.toMatchObject({ providerCode: 108 });
    }
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
  });
});
