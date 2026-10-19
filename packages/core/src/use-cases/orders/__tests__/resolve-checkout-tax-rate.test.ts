import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { TxRepos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";

import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "../_shared/resolve-checkout-tax-rate";

const clock: ClockPort = { now: () => new Date("2026-06-30T00:00:00.000Z") };

/**
 * Minimal TxRepos fake exposing only the surface the helper touches:
 * `places.getById`, `savedLocations.getById`, and `events.updateTaxRate`.
 * Everything else is left unimplemented — a call would throw and fail the test.
 */
type LocationOverride = {
  admissionTaxRateBps: number | null;
  postalCode: string | null;
  countryCode: string | null;
  region?: string | null;
};

function makeTx(overrides: {
  place?: LocationOverride | null;
  savedLocation?: LocationOverride | null;
  updateEventTaxRate?: ReturnType<typeof vi.fn>;
  /** The non-tx CONDITIONAL place cache write (`fillTaxRateIfUnset`). */
  updatePlaceTaxRate?: ReturnType<typeof vi.fn>;
  updateSavedLocationTaxRate?: ReturnType<typeof vi.fn>;
}): {
  tx: TxRepos;
  updateEventTaxRate: ReturnType<typeof vi.fn>;
  updatePlaceTaxRate: ReturnType<typeof vi.fn>;
} {
  // `fillTaxRateIfUnset` on the non-transaction repos (resolves "wrote").
  const updateEventTaxRate =
    overrides.updateEventTaxRate ?? vi.fn(async () => true);
  const updatePlaceTaxRate =
    overrides.updatePlaceTaxRate ?? vi.fn(async () => true);
  const updateSavedLocationTaxRate =
    overrides.updateSavedLocationTaxRate ?? vi.fn(async () => true);

  // The TRANSACTION's repos: neither the event stamp nor the location cache
  // may be written on it (a swallowed failed write there condemns the
  // transaction). The spies the tests assert on are the NON-transaction
  // repos' — written after the commit (see `resolveAndCommit`).
  const onTx = (what: string) =>
    vi.fn(async () => {
      throw new Error(`${what} written ON the transaction`);
    });
  const txWrites = [
    onTx("event stamp (updateTaxRate)"),
    onTx("event stamp (fillTaxRateIfUnset)"),
    onTx("place rate cache"),
    onTx("saved-location rate cache"),
    onTx("place rate cache (fillTaxRateIfUnset)"),
    onTx("saved-location rate cache (fillTaxRateIfUnset)"),
  ];
  const tx = {
    events: { updateTaxRate: txWrites[0], fillTaxRateIfUnset: txWrites[1] },
    places: {
      getById: vi.fn(async (id: string) =>
        overrides.place === undefined
          ? null
          : overrides.place
            ? { id, taxRateSource: null, ...overrides.place }
            : null,
      ),
      updateTaxRate: txWrites[2],
      fillTaxRateIfUnset: txWrites[4],
    },
    savedLocations: {
      getById: vi.fn(async (id: string) =>
        overrides.savedLocation === undefined
          ? null
          : overrides.savedLocation
            ? { id, taxRateSource: null, ...overrides.savedLocation }
            : null,
      ),
      updateTaxRate: txWrites[3],
      fillTaxRateIfUnset: txWrites[5],
    },
  } as unknown as TxRepos;
  // The location cache is written after the commit with the CONDITIONAL
  // write; the unconditional one on the non-tx repos is a test failure too.
  nonTxReposFor.set(tx, {
    events: { fillTaxRateIfUnset: updateEventTaxRate },
    places: {
      fillTaxRateIfUnset: updatePlaceTaxRate,
      updateTaxRate: onTx("place rate cache (unconditional, after commit)"),
    },
    savedLocations: {
      fillTaxRateIfUnset: updateSavedLocationTaxRate,
      updateTaxRate: onTx("saved-location rate cache (unconditional, after commit)"),
    },
  });
  txWritesFor.set(tx, txWrites);

  return { tx, updateEventTaxRate, updatePlaceTaxRate };
}

const nonTxReposFor = new WeakMap<object, unknown>();
const txWritesFor = new WeakMap<object, ReturnType<typeof vi.fn>[]>();
const expectNoTxWrites = (tx: object) => {
  for (const write of txWritesFor.get(tx) ?? []) {
    expect(write).not.toHaveBeenCalled();
  }
};

/**
 * The callers' shape: resolve ON the transaction (recording the self-heal),
 * then — the transaction committed — write it on the non-transaction repos.
 */
async function resolveAndCommit(
  ...args: Parameters<typeof resolveCheckoutTax>
): ReturnType<typeof resolveCheckoutTax> {
  const [deps, tx, event, logger] = args;
  const afterCommit = newCheckoutTaxAfterCommit();
  const result = await resolveCheckoutTax(deps, tx, event, logger, afterCommit);
  await applyCheckoutTaxSelfHeal(
    { repos: nonTxReposFor.get(tx) as never, reportError: deps.reportError },
    afterCommit,
    logger,
  );
  // Never on the transaction, whatever the outcome.
  expectNoTxWrites(tx);
  return result;
}

/** The event row's version as the checkout read it (`Event.updatedAt`). */
const EVENT_VERSION = new Date("2026-06-29T08:00:00.000Z");

const baseEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  updatedAt: EVENT_VERSION,
  admissionTaxRateBps: null as number | null,
  placeId: null as string | null,
  savedLocationId: null as string | null,
  postalCode: null as string | null,
  countryCode: null as string | null,
};

/**
 * The production bps-only wrapper is GONE (it discarded `taxableBase`, and a
 * money site must never get a rate without what the rate applies to). These
 * rate-focused cases keep their shape through a test-local projection.
 */
const resolveRateBps = async (
  ...args: Parameters<typeof resolveCheckoutTax>
): Promise<number> => (await resolveAndCommit(...args)).rateBps;

describe("resolveCheckoutTax — rate resolution", () => {
  it("returns the publish-time stamp and does no lookup when present", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 500, source: "ziptax" })),
    };
    const { tx, updateEventTaxRate } = makeTx({});

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, admissionTaxRateBps: 975 },
      undefined,
    );

    expect(rate).toBe(975);
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });

  it("returns a stamp of 0 without any lookup (0 is a real stamp, not 'missing')", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 500, source: "ziptax" })),
    };
    const { tx } = makeTx({});

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, admissionTaxRateBps: 0 },
      undefined,
    );

    expect(rate).toBe(0);
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("does a last-chance lookup and stamps the event when the stamp is null (place-backed)", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 825, source: "ziptax" })),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );

    expect(rate).toBe(825);
    expect(lookup.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "94103",
      countryCode: "US",
    });
    expect(updateEventTaxRate).toHaveBeenCalledWith({
      eventId: baseEvent.id,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("still returns the resolved non-zero rate when the stamp write-back throws", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 825, source: "ziptax" })),
    };
    const updateEventTaxRate = vi.fn(async () => {
      throw new Error("write-back failed");
    });
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
      updateEventTaxRate,
    });

    const warn = vi.fn();
    const error = vi.fn();
    const reportError = vi.fn();

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock, reportError },
      tx,
      { ...baseEvent, placeId: "place-1" },
      { info: vi.fn(), warn, error, debug: vi.fn() } as never,
    );

    // A failure to *persist* the self-heal stamp must NOT downgrade the order to 0.
    expect(rate).toBe(825);
    expect(updateEventTaxRate).toHaveBeenCalled();

    // `error`, NOT `warn`. The Sentry pino integration does not capture warn, so
    // for the whole life of this site the failure was invisible — a permanently
    // failing write-back would burn a paid tax-provider call on every checkout
    // for that event and never surface.
    expect(warn).not.toHaveBeenCalledWith(
      "tax_rate_backfill_writeback_failed",
      expect.anything(),
    );
    expect(error).toHaveBeenCalledWith(
      "tax_rate_backfill_writeback_failed",
      expect.objectContaining({ eventId: baseEvent.id }),
    );
    // The ONLY warn on this path is unrelated: this fixture's venue resolves to
    // a US situs with no region, which has no ruling in the taxable-base table
    // (`lib/pricing/taxable-base.ts`), so the base falls back to TICKET_FACE and
    // says so. Pinned rather than loosened, so a NEW warn here still fails.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "tax_taxable_base_situs_unruled",
      expect.objectContaining({ eventId: baseEvent.id, rateBps: 825 }),
    );
    // A deliberate swallow rides ReporterPort, per the project convention.
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "resolveCheckoutTax" },
      extra: {
        eventId: baseEvent.id,
        event: "tax_rate_backfill_writeback_failed",
      },
    });
  });

  it("rethrows a resolution fault instead of pricing the order at zero tax", async () => {
    // THE MONEY BUG. This catch used to return `{ rateBps: 0, situs: null }`,
    // and that zero was written to `orders.createPending` and funded the
    // PaymentIntent — a $40 ticket committing at $0 tax with the platform as
    // merchant of record, logged at `warn` so nobody would ever see it.
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 825, source: "ziptax" })),
    };
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });
    // A fault from a repo read the tolerant paths do not cover.
    (tx as unknown as { places: { getById: unknown } }).places.getById = vi.fn(
      async () => {
        throw new Error("40P01 deadlock detected");
      },
    );
    const reportError = vi.fn();

    await expect(
      resolveRateBps(
        { taxRateLookup: lookup, clock, reportError },
        tx,
        { ...baseEvent, placeId: "place-1" },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      ),
    ).rejects.toThrow(/deadlock/);
    expect(reportError).toHaveBeenCalled();
  });

  it("returns the cached place rate and stamps it onto the event (no provider call)", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => null),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: { admissionTaxRateBps: 700, postalCode: "94103", countryCode: "US" },
    });

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );

    expect(rate).toBe(700);
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(updateEventTaxRate).toHaveBeenCalledWith({
      eventId: baseEvent.id,
      admissionTaxRateBps: 700,
      taxRateSource: "unknown",
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("returns 0 and does not stamp when the lookup yields nothing", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => null),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );

    expect(rate).toBe(0);
    expect(lookup.lookupByPostalCode).toHaveBeenCalled();
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });

  // Owner ruling 2026-10-06: a failed lookup never charges 0%. The in-tx
  // fallback refuses with a retryable TAX_RATE_UNAVAILABLE, reported once.
  it("REFUSES (TAX_RATE_UNAVAILABLE) when the lookup throws — never charges 0", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => {
        throw new Error("ziptax 500");
      }),
    };
    const reportError = vi.fn();
    const { tx, updateEventTaxRate } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });

    await expect(
      resolveRateBps(
        { taxRateLookup: lookup, clock, reportError },
        tx,
        { ...baseEvent, placeId: "place-1" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "TAX_RATE_UNAVAILABLE" });

    expect(updateEventTaxRate).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when the event has no resolvable location", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 500, source: "ziptax" })),
    };
    const { tx, updateEventTaxRate } = makeTx({});

    const rate = await resolveRateBps(
      { taxRateLookup: lookup, clock },
      tx,
      baseEvent,
      undefined,
    );

    expect(rate).toBe(0);
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });

  it("returns 0 when no provider is configured even with a location", async () => {
    const { tx, updateEventTaxRate } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });

    const rate = await resolveRateBps(
      { taxRateLookup: null, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );

    expect(rate).toBe(0);
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });
});

describe("resolveCheckoutTax — TN instruction-only exemption", () => {
  it("corrects a stale non-zero STAMP to 0 / exempt for an instructional TN event (fast path)", async () => {
    // Stamped fast path: event carries a non-zero publish-time stamp (e.g.
    // organizer toggled instructionalAdmission on afterwards without re-saving).
    // The place resolves a TN situs, so the exemption zeroes the stamped rate.
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 925, source: "ziptax" })),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: {
        admissionTaxRateBps: 925,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
      },
    });

    const result = await resolveAndCommit(
      { taxRateLookup: lookup, clock },
      tx,
      {
        ...baseEvent,
        admissionTaxRateBps: 925,
        taxRateSource: "ziptax",
        placeId: "place-tn",
        instructionalAdmission: true,
      },
      undefined,
    );

    expect(result.rateBps).toBe(0);
    expect(result.rateSource).toBe("exempt:tn-instruction");
    // Fast path never does a provider lookup nor re-stamps.
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(updateEventTaxRate).not.toHaveBeenCalled();
  });

  it("does NOT exempt a stamped instructional event outside TN (fast path)", async () => {
    const { tx } = makeTx({
      place: {
        admissionTaxRateBps: 825,
        postalCode: "78701",
        countryCode: "US",
        region: "TX",
      },
    });

    const result = await resolveAndCommit(
      { taxRateLookup: null, clock },
      tx,
      {
        ...baseEvent,
        admissionTaxRateBps: 825,
        taxRateSource: "ziptax",
        placeId: "place-tx",
        instructionalAdmission: true,
      },
      undefined,
    );

    expect(result.rateBps).toBe(825);
    expect(result.rateSource).toBe("ziptax");
  });

  it("exempts a freshly-resolved rate and stamps 0 / exempt for an instructional TN event (fresh path)", async () => {
    // No stamp on the event → fresh resolve. The place's cached TN rate is
    // resolved, then zeroed by the exemption, and the self-heal write persists
    // the exempt rate/source.
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => null),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: {
        admissionTaxRateBps: 925,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
      },
    });

    const result = await resolveAndCommit(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-tn", instructionalAdmission: true },
      undefined,
    );

    expect(result.rateBps).toBe(0);
    expect(result.rateSource).toBe("exempt:tn-instruction");
    expect(updateEventTaxRate).toHaveBeenCalledWith({
      eventId: baseEvent.id,
      admissionTaxRateBps: 0,
      taxRateSource: "exempt:tn-instruction",
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("does NOT exempt a freshly-resolved rate outside TN (fresh path)", async () => {
    const lookup: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => null),
    };
    const { tx, updateEventTaxRate } = makeTx({
      place: {
        admissionTaxRateBps: 825,
        postalCode: "78701",
        countryCode: "US",
        region: "TX",
      },
    });

    const result = await resolveAndCommit(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-tx", instructionalAdmission: true },
      undefined,
    );

    expect(result.rateBps).toBe(825);
    expect(result.rateSource).toBe("unknown");
    expect(updateEventTaxRate).toHaveBeenCalledWith({
      eventId: baseEvent.id,
      admissionTaxRateBps: 825,
      taxRateSource: "unknown",
      expectedUpdatedAt: EVENT_VERSION,
    });
  });
});

describe("resolveCheckoutTax — the self-heal stamp runs AFTER the commit", () => {
  const lookup: TaxRateLookupPort = {
    lookupByPostalCode: vi.fn(async () => ({ rateBps: 825, source: "ziptax" })),
  };

  it("regression: nothing is written on the transaction — the stamp is recorded for after the commit", async () => {
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });
    const afterCommit = newCheckoutTaxAfterCommit();

    const result = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
      afterCommit,
    );

    expect(result.rateBps).toBe(825);
    expectNoTxWrites(tx);
    expect(afterCommit.selfHeal).toEqual({
      eventId: baseEvent.id,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
      expectedUpdatedAt: EVENT_VERSION,
    });
  });

  it("a failed after-commit write is REPORTED and never throws (the order already committed at the right rate)", async () => {
    const reportError = vi.fn();
    const boom = new Error("23514 check violation");
    await expect(
      applyCheckoutTaxSelfHeal(
        {
          repos: {
            events: { fillTaxRateIfUnset: vi.fn(async () => { throw boom; }) },
          } as never,
          reportError,
        },
        {
          selfHeal: {
            eventId: baseEvent.id,
            admissionTaxRateBps: 825,
            taxRateSource: "ziptax",
            expectedUpdatedAt: EVENT_VERSION,
          },
          locationCache: null,
        },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      ),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "resolveCheckoutTax" },
      extra: { eventId: baseEvent.id, event: "tax_rate_backfill_writeback_failed" },
    });
  });

  it("no container (the seed pricing path) → nothing recorded, nothing written", async () => {
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });
    await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );
    expectNoTxWrites(tx);
  });

  it("regression: the place's rate cache from a fresh lookup is written after the commit too — never on the transaction", async () => {
    const { tx, updatePlaceTaxRate } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });
    await resolveAndCommit(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
    );
    expect(updatePlaceTaxRate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "place-1",
        admissionTaxRateBps: 825,
        taxRateSource: "ziptax",
      }),
    );
  });

  it("regression: a stamp committed BETWEEN resolve and the after-commit write is never overwritten (compare-and-set on NULL)", async () => {
    // TN, never stamped, instruction-only: the checkout resolves 0 / exempt.
    const lookupTn: TaxRateLookupPort = {
      lookupByPostalCode: vi.fn(async () => null),
    };
    const { tx } = makeTx({
      place: { admissionTaxRateBps: 975, postalCode: "37203", countryCode: "US", region: "TN" },
    });
    const afterCommit = newCheckoutTaxAfterCommit();
    const result = await resolveCheckoutTax(
      { taxRateLookup: lookupTn, clock },
      tx,
      { ...baseEvent, placeId: "place-tn", instructionalAdmission: true },
      undefined,
      afterCommit,
    );
    expect(result.rateSource).toBe("exempt:tn-instruction");

    // Meanwhile the organiser turns instruction-only OFF and the settings
    // save commits the real 975 stamp. The row models the adapter's CAS.
    const row = { admissionTaxRateBps: 975 as number | null, taxRateSource: "ziptax" };
    const fillTaxRateIfUnset = vi.fn(
      async (input: { admissionTaxRateBps: number; taxRateSource: string }) => {
        if (row.admissionTaxRateBps !== null) return false;
        row.admissionTaxRateBps = input.admissionTaxRateBps;
        row.taxRateSource = input.taxRateSource;
        return true;
      },
    );
    const updateTaxRate = vi.fn();
    await applyCheckoutTaxSelfHeal(
      {
        repos: {
          events: { fillTaxRateIfUnset, updateTaxRate },
          places: { updateTaxRate: vi.fn() },
          savedLocations: { updateTaxRate: vi.fn() },
        } as never,
      },
      afterCommit,
      undefined,
    );

    expect(fillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    expect(updateTaxRate).not.toHaveBeenCalled();
    // The settings save wins: later checkouts collect 9.75%, not $0.
    expect(row).toEqual({ admissionTaxRateBps: 975, taxRateSource: "ziptax" });
  });
});

describe("resolveCheckoutTax — a situs read fault on the transaction is not swallowed", () => {
  it("regression: a failed Place read on the stamped (fast) path is reported and RETHROWN, not stamped as a null situs", async () => {
    const { tx } = makeTx({
      place: { admissionTaxRateBps: 825, postalCode: "94103", countryCode: "US" },
    });
    (tx as unknown as { places: { getById: unknown } }).places.getById = vi.fn(
      async () => {
        throw new Error("57014 statement timeout");
      },
    );
    const reportError = vi.fn();

    await expect(
      resolveCheckoutTax(
        { taxRateLookup: null, clock, reportError },
        tx,
        { ...baseEvent, admissionTaxRateBps: 825, placeId: "place-1" },
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      ),
    ).rejects.toThrow(/statement timeout/);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ event: "tax_situs_resolution_failed" }),
      }),
    );
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// In-memory rows that model the adapters' compare-and-set WHERE clauses —
// including Prisma's "`undefined` means no filter", so a caller that does not
// send a condition gets the unconditional behaviour it would get for real.
// ─────────────────────────────────────────────────────────────────────────────
type EventRow = {
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  updatedAt: Date;
};
function eventRowRepo(row: EventRow) {
  return {
    fillTaxRateIfUnset: vi.fn(
      async (input: {
        admissionTaxRateBps: number;
        taxRateSource: string;
        expectedUpdatedAt?: Date;
      }) => {
        if (row.admissionTaxRateBps !== null) return false;
        if (
          input.expectedUpdatedAt !== undefined &&
          input.expectedUpdatedAt.getTime() !== row.updatedAt.getTime()
        ) {
          return false;
        }
        row.admissionTaxRateBps = input.admissionTaxRateBps;
        row.taxRateSource = input.taxRateSource;
        return true;
      },
    ),
    updateTaxRate: vi.fn(async () => {
      throw new Error("unconditional event stamp after the commit");
    }),
  };
}

type LocationRow = {
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  postalCode: string | null;
  countryCode: string | null;
};
function locationRowRepo(row: LocationRow) {
  const write = (input: {
    admissionTaxRateBps: number;
    taxRateSource: string;
  }) => {
    row.admissionTaxRateBps = input.admissionTaxRateBps;
    row.taxRateSource = input.taxRateSource;
  };
  return {
    updateTaxRate: vi.fn(
      async (input: { admissionTaxRateBps: number; taxRateSource: string }) => {
        write(input);
      },
    ),
    fillTaxRateIfUnset: vi.fn(
      async (input: {
        admissionTaxRateBps: number;
        taxRateSource: string;
        expectedPostalCode?: string | null;
        expectedCountryCode?: string | null;
      }) => {
        if (row.admissionTaxRateBps !== null) return false;
        if (
          input.expectedPostalCode !== undefined &&
          input.expectedPostalCode !== row.postalCode
        )
          return false;
        if (
          input.expectedCountryCode !== undefined &&
          input.expectedCountryCode !== row.countryCode
        )
          return false;
        write(input);
        return true;
      },
    ),
  };
}

describe("self-heal stamp — compare-and-set on the event row's VERSION (task: toggle-off left NULL)", () => {
  // TN, never stamped, instruction-only; the venue's cached base rate is 9.75%.
  const tnPlace = {
    admissionTaxRateBps: 975,
    postalCode: "37203",
    countryCode: "US",
    region: "TN",
  };
  const resolveExempt = async () => {
    const { tx } = makeTx({ place: tnPlace });
    const afterCommit = newCheckoutTaxAfterCommit();
    const result = await resolveCheckoutTax(
      { taxRateLookup: null, clock },
      tx,
      { ...baseEvent, placeId: "place-tn", instructionalAdmission: true },
      undefined,
      afterCommit,
    );
    expect(result).toMatchObject({
      rateBps: 0,
      rateSource: "exempt:tn-instruction",
    });
    return afterCommit;
  };

  it("regression: a settings save that turned instruction-only OFF and left the stamp NULL makes the stale fill a no-op", async () => {
    const afterCommit = await resolveExempt();

    // Meanwhile: the organiser turns instruction-only OFF. The settings save's
    // provider lookup misses, so it leaves the stamp NULL — but it is a write
    // to the event row, so the row's version moves.
    const row: EventRow = {
      admissionTaxRateBps: null,
      taxRateSource: null,
      updatedAt: new Date(EVENT_VERSION.getTime() + 60_000),
    };
    const events = eventRowRepo(row);

    await applyCheckoutTaxSelfHeal(
      { repos: { events } as never },
      afterCommit,
      undefined,
    );

    expect(events.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUpdatedAt: EVENT_VERSION }),
    );
    // NOT stamped 0 / exempt: the next checkout resolves the real rate.
    expect(row.admissionTaxRateBps).toBeNull();
    expect(events.updateTaxRate).not.toHaveBeenCalled();
  });

  it("the normal case — never stamped, nothing written since the read — fills the stamp", async () => {
    const afterCommit = await resolveExempt();
    const row: EventRow = {
      admissionTaxRateBps: null,
      taxRateSource: null,
      updatedAt: EVENT_VERSION,
    };
    await applyCheckoutTaxSelfHeal(
      { repos: { events: eventRowRepo(row) } as never },
      afterCommit,
      undefined,
    );
    expect(row).toMatchObject({
      admissionTaxRateBps: 0,
      taxRateSource: "exempt:tn-instruction",
    });
  });

  it("an event read without a row version records no self-heal at all (no unguarded write)", async () => {
    const { tx } = makeTx({ place: tnPlace });
    const afterCommit = newCheckoutTaxAfterCommit();
    const { updatedAt: _omit, ...unversioned } = baseEvent;
    await resolveCheckoutTax(
      { taxRateLookup: null, clock },
      tx,
      { ...unversioned, placeId: "place-tn" },
      undefined,
      afterCommit,
    );
    expect(afterCommit.selfHeal).toBeNull();
  });
});

describe("after-commit Place / SavedLocation cache write is conditional (task: no overwrite of a newer rate)", () => {
  const providerAt = (rateBps: number) => ({
    lookupByPostalCode: vi.fn(async () => ({ rateBps, source: "ziptax" })),
  });

  /** A checkout that looked up the place's OLD postal code (cache miss). */
  const checkoutAgainstOldAddress = async () => {
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" },
    });
    const afterCommit = newCheckoutTaxAfterCommit();
    await resolveCheckoutTax(
      { taxRateLookup: providerAt(863), clock },
      tx,
      { ...baseEvent, placeId: "place-1" },
      undefined,
      afterCommit,
    );
    return afterCommit;
  };

  it("writes with the postal code / country the lookup was made for, through the conditional write only", async () => {
    const afterCommit = await checkoutAgainstOldAddress();
    const place: LocationRow = {
      admissionTaxRateBps: null,
      taxRateSource: null,
      postalCode: "94103",
      countryCode: "US",
    };
    const places = locationRowRepo(place);

    await applyCheckoutTaxSelfHeal(
      {
        repos: {
          events: eventRowRepo({
            admissionTaxRateBps: null,
            taxRateSource: null,
            updatedAt: EVENT_VERSION,
          }),
          places,
        } as never,
      },
      afterCommit,
      undefined,
    );

    expect(places.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "place-1",
        expectedPostalCode: "94103",
        expectedCountryCode: "US",
        admissionTaxRateBps: 863,
        taxRateSource: "ziptax",
      }),
    );
    expect(places.updateTaxRate).not.toHaveBeenCalled();
    // Still at the looked-up address and still empty → it caches.
    expect(place.admissionTaxRateBps).toBe(863);
  });

  it("regression: the owner moved the venue meanwhile and upsertPlace cached the NEW rate → the checkout's old rate does not overwrite it", async () => {
    const afterCommit = await checkoutAgainstOldAddress();
    // Address edited to 10001; upsertPlace looked it up and cached 887.
    const place: LocationRow = {
      admissionTaxRateBps: 887,
      taxRateSource: "ziptax",
      postalCode: "10001",
      countryCode: "US",
    };
    await applyCheckoutTaxSelfHeal(
      {
        repos: {
          events: eventRowRepo({
            admissionTaxRateBps: null,
            taxRateSource: null,
            updatedAt: EVENT_VERSION,
          }),
          places: locationRowRepo(place),
        } as never,
      },
      afterCommit,
      undefined,
    );
    expect(place).toMatchObject({ admissionTaxRateBps: 887, postalCode: "10001" });
  });

  it("regression: the owner moved the venue and upsertPlace's lookup MISSED (cache still empty) → the old address's rate is still not written", async () => {
    const afterCommit = await checkoutAgainstOldAddress();
    const place: LocationRow = {
      admissionTaxRateBps: null,
      taxRateSource: null,
      postalCode: "10001",
      countryCode: "US",
    };
    await applyCheckoutTaxSelfHeal(
      {
        repos: {
          events: eventRowRepo({
            admissionTaxRateBps: null,
            taxRateSource: null,
            updatedAt: EVENT_VERSION,
          }),
          places: locationRowRepo(place),
        } as never,
      },
      afterCommit,
      undefined,
    );
    expect(place.admissionTaxRateBps).toBeNull();
  });

  it("same guard for a SavedLocation-backed event", async () => {
    const { tx } = makeTx({
      savedLocation: {
        admissionTaxRateBps: null,
        postalCode: "94103",
        countryCode: "US",
      },
    });
    const afterCommit = newCheckoutTaxAfterCommit();
    await resolveCheckoutTax(
      { taxRateLookup: providerAt(863), clock },
      tx,
      { ...baseEvent, savedLocationId: "saved-1" },
      undefined,
      afterCommit,
    );
    const saved: LocationRow = {
      admissionTaxRateBps: 887,
      taxRateSource: "ziptax",
      postalCode: "10001",
      countryCode: "US",
    };
    const savedLocations = locationRowRepo(saved);
    await applyCheckoutTaxSelfHeal(
      {
        repos: {
          events: eventRowRepo({
            admissionTaxRateBps: null,
            taxRateSource: null,
            updatedAt: EVENT_VERSION,
          }),
          savedLocations,
        } as never,
      },
      afterCommit,
      undefined,
    );
    expect(savedLocations.fillTaxRateIfUnset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-1",
        expectedPostalCode: "94103",
        expectedCountryCode: "US",
      }),
    );
    expect(savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(saved.admissionTaxRateBps).toBe(887);
  });
});

describe("prepareCheckoutTax — the provider lookup happens before the transaction", () => {
  const usPlace = { admissionTaxRateBps: null, postalCode: "94103", countryCode: "US" };

  /** Non-tx repos for the pre-transaction read (a sellable event by default). */
  const nonTx = (event: Record<string, unknown> | null, place = usPlace) => ({
    events: {
      getById: vi.fn(async () =>
        event
          ? {
              status: "PUBLISHED",
              attendanceMode: "TICKETED",
              // Still ahead of the fixed clock (2026-06-30): sales are open.
              startsAt: new Date("2026-12-01T20:00:00.000Z"),
              endsAt: null,
              ...event,
            }
          : null,
      ),
    },
    places: {
      getById: vi.fn(async (id: string) => ({ id, taxRateSource: null, ...place })),
    },
    savedLocations: { getById: vi.fn(async () => null) },
  });

  it("prepares before; inside the transaction the prepared result is used and the provider is NOT called again", async () => {
    const lookup = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 863, source: "ziptax" })),
    };
    const event = { ...baseEvent, placeId: "place-1" };
    const prepared = await prepareCheckoutTax(
      { taxRateLookup: lookup, clock, repos: nonTx(event) as never },
      event.id,
      undefined,
    );
    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);

    // The transaction's place read would say something else entirely — it is
    // not consulted for the rate, proving the prepared result was used.
    const { tx } = makeTx({ place: usPlace });
    const afterCommit = newCheckoutTaxAfterCommit();
    const result = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      event,
      undefined,
      afterCommit,
      prepared,
    );

    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ rateBps: 863, rateSource: "ziptax" });
    expect(afterCommit.selfHeal).toMatchObject({
      admissionTaxRateBps: 863,
      expectedUpdatedAt: EVENT_VERSION,
    });
    expect(afterCommit.locationCache?.cacheAddress).toEqual({
      postalCode: "94103",
      countryCode: "US",
    });
  });

  it.each([
    ["unpublished", { status: "DRAFT" }],
    ["RSVP", { attendanceMode: "RSVP" }],
  ])(
    "an %s event prepares nothing: no paid lookup for a checkout the transaction will refuse",
    async (_label, overrides) => {
      const lookup = { lookupByPostalCode: vi.fn() };
      const prepared = await prepareCheckoutTax(
        {
          taxRateLookup: lookup,
          clock,
          repos: nonTx({ ...baseEvent, placeId: "place-1", ...overrides }) as never,
        },
        baseEvent.id,
        undefined,
      );
      expect(prepared.prepared).toBeNull();
      expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "an ended (sales closed)",
      {
        startsAt: new Date("2026-06-29T19:00:00.000Z"),
        endsAt: new Date("2026-06-29T23:00:00.000Z"),
      },
    ],
    [
      "an ended-at-start (no endsAt) ",
      { startsAt: new Date("2026-06-30T00:00:00.000Z"), endsAt: null },
    ],
  ])(
    "%s event prepares nothing: no paid lookup for a sale the transaction will refuse",
    async (_label, overrides) => {
      const lookup = { lookupByPostalCode: vi.fn() };
      const prepared = await prepareCheckoutTax(
        {
          taxRateLookup: lookup,
          clock,
          repos: nonTx({ ...baseEvent, placeId: "place-1", ...overrides }) as never,
        },
        baseEvent.id,
        undefined,
      );
      expect(prepared.prepared).toBeNull();
      expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
    },
  );

  it("resale: an unpublished event is still prepared (resale does not refuse on status); primary skips it; an ended one is skipped by both", async () => {
    const lookup = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 863, source: "ziptax" })),
    };
    const draft = { ...baseEvent, placeId: "place-1", status: "DRAFT" };
    const primary = await prepareCheckoutTax(
      { taxRateLookup: lookup, clock, repos: nonTx(draft) as never },
      baseEvent.id,
      undefined,
    );
    expect(primary.prepared).toBeNull();
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();

    const resale = await prepareCheckoutTax(
      { taxRateLookup: lookup, clock, repos: nonTx(draft) as never },
      baseEvent.id,
      undefined,
      { sale: "resale" },
    );
    expect(resale.prepared).not.toBeNull();
    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);

    const ended = await prepareCheckoutTax(
      {
        taxRateLookup: lookup,
        clock,
        repos: nonTx({
          ...baseEvent,
          placeId: "place-1",
          startsAt: new Date("2026-06-29T19:00:00.000Z"),
          endsAt: new Date("2026-06-29T23:00:00.000Z"),
        }) as never,
      },
      baseEvent.id,
      undefined,
      { sale: "resale" },
    );
    expect(ended.prepared).toBeNull();
    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("nothing prepared (skipped before the transaction) → resolved in the transaction at the provider's rate, with the stale warning", async () => {
    const lookup = {
      lookupByPostalCode: vi.fn(async () => ({ rateBps: 863, source: "ziptax" })),
    };
    const warn = vi.fn();
    const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const event = { ...baseEvent, placeId: "place-1" };
    const { tx } = makeTx({ place: usPlace });

    const result = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      event,
      logger as never,
      newCheckoutTaxAfterCommit(),
      { refKey: null, prepared: null },
    );

    expect(result.rateBps).toBe(863);
    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "tax_rate_prepared_stale_resolving_in_tx",
      expect.objectContaining({ eventId: event.id, preparedRefKey: null }),
    );
  });

  it("a stamped event prepares nothing and calls no provider", async () => {
    const lookup = { lookupByPostalCode: vi.fn() };
    const prepared = await prepareCheckoutTax(
      {
        taxRateLookup: lookup,
        clock,
        repos: nonTx({ ...baseEvent, placeId: "place-1", admissionTaxRateBps: 975 }) as never,
      },
      baseEvent.id,
      undefined,
    );
    expect(prepared.prepared).toBeNull();
    expect(lookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("the event moved between the two reads → resolved again inside (never charged at the old venue's rate)", async () => {
    const lookup = {
      lookupByPostalCode: vi.fn(async ({ postalCode }: { postalCode: string }) => ({
        rateBps: postalCode === "94103" ? 863 : 887,
        source: "ziptax",
      })),
    };
    const before = { ...baseEvent, placeId: "place-old" };
    const prepared = await prepareCheckoutTax(
      { taxRateLookup: lookup, clock, repos: nonTx(before) as never },
      before.id,
      undefined,
    );
    const { tx } = makeTx({
      place: { admissionTaxRateBps: null, postalCode: "10001", countryCode: "US" },
    });
    const warn = vi.fn();
    const result = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      { ...baseEvent, placeId: "place-new" },
      { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      newCheckoutTaxAfterCommit(),
      prepared,
    );
    expect(result.rateBps).toBe(887);
    expect(warn).toHaveBeenCalledWith(
      "tax_rate_prepared_stale_resolving_in_tx",
      expect.objectContaining({ preparedRefKey: "place:place-old" }),
    );
  });

  it("a repo fault before the transaction is reported and RETHROWN — never priced at $0", async () => {
    const reportError = vi.fn();
    const repos = nonTx({ ...baseEvent, placeId: "place-1" });
    repos.places.getById = vi.fn(async () => {
      throw new Error("57P01 admin shutdown");
    });
    await expect(
      prepareCheckoutTax(
        { taxRateLookup: null, clock, reportError, repos: repos as never },
        baseEvent.id,
        { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      ),
    ).rejects.toThrow(/admin shutdown/);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({
          event: "tax_rate_checkout_resolution_failed",
        }),
      }),
    );
  });

  it("a provider miss before the transaction prices at 0, as before (not a fault)", async () => {
    const lookup = { lookupByPostalCode: vi.fn(async () => null) };
    const event = { ...baseEvent, placeId: "place-1" };
    const prepared = await prepareCheckoutTax(
      { taxRateLookup: lookup, clock, repos: nonTx(event) as never },
      event.id,
      undefined,
    );
    const { tx } = makeTx({ place: usPlace });
    const result = await resolveCheckoutTax(
      { taxRateLookup: lookup, clock },
      tx,
      event,
      undefined,
      newCheckoutTaxAfterCommit(),
      prepared,
    );
    expect(result).toMatchObject({ rateBps: 0, rateSource: "none" });
    expect(lookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });
});
