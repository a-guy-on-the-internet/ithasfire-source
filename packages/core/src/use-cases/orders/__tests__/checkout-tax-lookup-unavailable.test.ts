import { describe, expect, it, vi } from "vitest";

import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";

import {
  TAX_LOOKUP_RETRY_DELAYS_MS,
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "../_shared/resolve-checkout-tax-rate";

/**
 * Owner ruling 2026-10-06: "We can't be charging 0% tax." A checkout whose
 * venue rate is unknown RETRIES the provider lookup (twice, before the
 * transaction) and then REFUSES with TAX_RATE_UNAVAILABLE — reported once —
 * instead of pricing the order at 0. A GENUINE 0 (the provider says 0, no
 * location, "no rate here") is still charged.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const clock = { now: () => NOW };

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    startsAt: new Date("2026-11-01T19:00:00.000Z"),
    endsAt: new Date("2026-11-01T22:00:00.000Z"),
    timezone: "America/Chicago",
    admissionTaxRateBps: null,
    taxRateSource: null,
    instructionalAdmission: false,
    placeId: PLACE_ID,
    savedLocationId: null,
    postalCode: null,
    countryCode: null,
    region: null,
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    ...overrides,
  };
}

const minneapolisPlace = {
  id: PLACE_ID,
  addressLine1: "600 N 1st Ave",
  city: "Minneapolis",
  region: "MN",
  postalCode: "55403",
  countryCode: "US",
  admissionTaxRateBps: null as number | null,
  taxRateSource: null as string | null,
};

function makeRepos(event = makeEvent()) {
  const repos = {
    events: {
      getById: vi.fn(async () => event),
      fillTaxRateIfUnset: vi.fn(async () => true),
      listUnstampedUpcomingIdsAtTaxLocation: vi.fn(async () => [
        "sibling-event-1",
      ]),
    },
    places: {
      getById: vi.fn(async () => ({ ...minneapolisPlace })),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    savedLocations: { getById: vi.fn(async () => null) },
    searchReindexPending: {
      mark: vi.fn(async () => undefined),
    },
    tx: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> =>
        fn(repos),
    ),
  };
  return repos;
}

const rateLimited = () =>
  new TaxRateLookupError("Ziptax rCode 108 (RESPONSE_CODE_REQUEST_LIMIT_MET)", {
    providerCode: 108,
    httpStatus: 429,
  });

describe("prepareCheckoutTax — a failed provider lookup is retried, then refused", () => {
  it("retries twice with the short backoff, then refuses TAX_RATE_UNAVAILABLE and reports ONCE", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });
    const reportError = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      prepareCheckoutTax(
        {
          repos: repos as never,
          taxRateLookup: { lookupByPostalCode },
          clock,
          reportError,
          sleep,
        },
        EVENT_ID,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      ...TAX_LOOKUP_RETRY_DELAYS_MS,
    ]);
    // One Sentry event for the refusal, carrying the provider's code — not
    // one per attempt.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "checkoutTaxRateUnavailable" },
      extra: { eventId: EVENT_ID, attempts: 3, providerCode: 108 },
    });
    // The street address was offered to the provider.
    expect(lookupByPostalCode.mock.calls[0]).toEqual([
      {
        postalCode: "55403",
        countryCode: "US",
        street: "600 N 1st Ave",
        city: "Minneapolis",
        region: "MN",
      },
    ]);
    // Nothing was opened, nothing written.
    expect(repos.tx).not.toHaveBeenCalled();
    expect(repos.places.fillTaxRateIfUnset).not.toHaveBeenCalled();
  });

  it("a lookup that recovers on retry prices the order at the provider's rate, no report", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ rateBps: 903, source: "ziptax" });
    const reportError = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const deps = {
      repos: repos as never,
      taxRateLookup: { lookupByPostalCode },
      clock,
      reportError,
      sleep,
    };

    const prepared = await prepareCheckoutTax(deps, EVENT_ID, undefined);

    expect(lookupByPostalCode).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(reportError).not.toHaveBeenCalled();

    const afterCommit = newCheckoutTaxAfterCommit();
    const resolution = await resolveCheckoutTax(
      deps,
      repos as never,
      makeEvent() as never,
      undefined,
      afterCommit,
      prepared,
    );
    expect(resolution.rateBps).toBe(903);
    expect(resolution.rateSource).toBe("ziptax");
    // Cached on the venue after the commit, never inside the transaction.
    expect(afterCommit.locationCache?.fresh?.rateBps).toBe(903);
  });

  it("a REAL 0 from the provider is still charged as 0 — not refused", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => ({
      rateBps: 0,
      source: "ziptax",
    }));
    const deps = {
      repos: repos as never,
      taxRateLookup: { lookupByPostalCode },
      clock,
      sleep: vi.fn(async () => undefined),
    };

    const prepared = await prepareCheckoutTax(deps, EVENT_ID, undefined);
    const resolution = await resolveCheckoutTax(
      deps,
      repos as never,
      makeEvent() as never,
      undefined,
      newCheckoutTaxAfterCommit(),
      prepared,
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(resolution.rateBps).toBe(0);
    expect(resolution.rateSource).toBe("ziptax");
  });

  it("a provider that answers 'no rate for this place' (null) is a genuine 0, not a refusal", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => null);
    const deps = {
      repos: repos as never,
      taxRateLookup: { lookupByPostalCode },
      clock,
      sleep: vi.fn(async () => undefined),
    };

    const prepared = await prepareCheckoutTax(deps, EVENT_ID, undefined);
    const resolution = await resolveCheckoutTax(
      deps,
      repos as never,
      makeEvent() as never,
      undefined,
      newCheckoutTaxAfterCommit(),
      prepared,
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(resolution.rateBps).toBe(0);
    expect(resolution.rateSource).toBe("none");
  });
});

describe("prepareCheckoutTax — the retries run inside a wall-clock budget", () => {
  it("an attempt still running when the budget runs out is abandoned: refused, reported once, no retry", async () => {
    const repos = makeRepos();
    // A timeout outage: the provider never answers within the budget.
    const lookupByPostalCode = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const reportError = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const startedAt = Date.now();

    await expect(
      prepareCheckoutTax(
        {
          repos: repos as never,
          taxRateLookup: { lookupByPostalCode },
          clock,
          reportError,
          sleep,
          taxLookupBudgetMs: 60,
        },
        EVENT_ID,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "checkoutTaxRateUnavailable" },
      extra: { eventId: EVENT_ID, attempts: 1, budgetExhausted: true },
    });
    expect(repos.tx).not.toHaveBeenCalled();
  });

  it("a slow FAILED attempt that leaves too little budget is not retried", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw rateLimited();
    });
    const reportError = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(
      prepareCheckoutTax(
        {
          repos: repos as never,
          taxRateLookup: { lookupByPostalCode },
          clock,
          reportError,
          sleep,
          // 80ms used, 250ms pause + 500ms floor do not fit in what is left.
          taxLookupBudgetMs: 700,
        },
        EVENT_ID,
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: { attempts: 1, providerCode: 108 },
    });
  });

  it("fast failures inside the default budget still get both retries", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ rateBps: 903, source: "ziptax" });
    const sleep = vi.fn(async () => undefined);

    const result = await prepareCheckoutTax(
      {
        repos: repos as never,
        taxRateLookup: { lookupByPostalCode },
        clock,
        sleep,
      },
      EVENT_ID,
      undefined,
    );

    expect(lookupByPostalCode).toHaveBeenCalledTimes(3);
    expect(result.prepared?.stamp?.rateBps).toBe(903);
  });
});

describe("resolveCheckoutTax — the in-transaction fallback never charges 0 on a failed lookup", () => {
  it("refuses TAX_RATE_UNAVAILABLE (no retry inside the transaction), reported once", async () => {
    const repos = makeRepos();
    const lookupByPostalCode = vi.fn(async () => {
      throw rateLimited();
    });
    const reportError = vi.fn();

    await expect(
      resolveCheckoutTax(
        { taxRateLookup: { lookupByPostalCode }, clock, reportError },
        repos as never,
        makeEvent() as never,
        undefined,
        newCheckoutTaxAfterCommit(),
        // Nothing prepared → the fallback resolves on the transaction.
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: { stage: "transaction", providerCode: 108 },
    });
  });
});

describe("applyCheckoutTaxSelfHeal — a venue cache fill re-indexes the venue's events", () => {
  it("marks the checkout's own event and the venue's unstamped siblings for the search drain", async () => {
    const repos = makeRepos();
    const afterCommit = newCheckoutTaxAfterCommit();
    afterCommit.locationCache = {
      fresh: { rateBps: 903, source: "ziptax", fetchedAt: NOW },
      cacheTarget: { kind: "place", placeId: PLACE_ID },
      cacheAddress: { postalCode: "55403", countryCode: "US" },
    };
    afterCommit.selfHeal = {
      eventId: EVENT_ID,
      admissionTaxRateBps: 903,
      taxRateSource: "ziptax",
      expectedUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
    };

    await applyCheckoutTaxSelfHeal(
      { repos: repos as never, reportError: vi.fn() },
      afterCommit,
      undefined,
    );

    await vi.waitFor(() =>
      expect(repos.searchReindexPending.mark).toHaveBeenCalledTimes(1),
    );
    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).toHaveBeenCalledWith(
      {
        target: { kind: "place", placeId: PLACE_ID },
        now: NOW,
        limit: expect.any(Number),
      },
    );
    const marked = (
      repos.searchReindexPending.mark.mock.calls[0] as unknown as [
        Array<{ entityType: string; entityId: string }>,
      ]
    )[0];
    expect(marked.map((m) => m.entityId).sort()).toEqual(
      [EVENT_ID, "sibling-event-1"].sort(),
    );
  });

  it("no fill (another writer cached first) → no reindex", async () => {
    const repos = makeRepos();
    repos.places.fillTaxRateIfUnset.mockResolvedValueOnce(false);
    const afterCommit = newCheckoutTaxAfterCommit();
    afterCommit.locationCache = {
      fresh: { rateBps: 903, source: "ziptax", fetchedAt: NOW },
      cacheTarget: { kind: "place", placeId: PLACE_ID },
      cacheAddress: { postalCode: "55403", countryCode: "US" },
    };

    await applyCheckoutTaxSelfHeal(
      { repos: repos as never },
      afterCommit,
      undefined,
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(repos.events.listUnstampedUpcomingIdsAtTaxLocation).not.toHaveBeenCalled();
    expect(repos.searchReindexPending.mark).not.toHaveBeenCalled();
  });
});
