import { describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";
import { makeStubSavedLocationRecord } from "@th/test-utils/fakes/stub-records";

import {
  commitPreparedEventTaxRate,
  prepareEventTaxRate,
  type EventTaxRateLocationRef,
  type TaxRateLocationReader,
} from "../resolve-event-tax-rate";

// A Canadian province with no entry in the GST/HST table resolves no rate and
// checkout then sells at 0% (`resolveCheckoutTax`, the `!resolved` branch). The
// branch logs a `warn`, which Sentry does not capture, and reports through
// `reportError`, which it does.

const NOW = new Date("2026-10-10T00:00:00.000Z");
const clock = { now: () => NOW };

const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const SAVED_LOCATION_ID = "00000000-0000-4000-8000-0000000000b1";
const LOG_CONTEXT = { eventId: "evt-1", source: "checkout" };

const WARN = "tax_rate_ca_province_unsupported";
const TAGS = {
  useCase: "resolveEventTaxRate",
  reason: "ca_province_unsupported",
};

const PLACE_REF: EventTaxRateLocationRef = { kind: "place", placeId: PLACE_ID };

/** The columns `hydrateTaxRateLocation` reads off a Place row. */
function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    addressLine1: "100 Queen St W",
    city: "Toronto",
    region: "ON",
    postalCode: "M5H 2N2",
    countryCode: "CA",
    admissionTaxRateBps: null,
    taxRateSource: null,
    ...overrides,
  } as unknown as PlaceRecord;
}

function makeReader(
  rows: {
    place?: PlaceRecord | null;
    savedLocation?: SavedLocationRecord | null;
  } = {},
): TaxRateLocationReader {
  return {
    places: { getById: vi.fn(async () => rows.place ?? null) },
    savedLocations: { getById: vi.fn(async () => rows.savedLocation ?? null) },
  };
}

function makeLogger() {
  const logger = {
    child: vi.fn(),
    withTime: vi.fn(),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger as typeof logger & LoggerPort;
}

/** A provider that must never be asked: the Canada table runs before it. */
function makeLookup() {
  return {
    lookupByPostalCode: vi.fn(async () => ({ rateBps: 999, source: "ziptax" })),
  };
}

function inlineRef(
  region: string | null,
  postalCode: string | null,
): EventTaxRateLocationRef {
  return { kind: "inline", postalCode, countryCode: "CA", region };
}

describe("prepareEventTaxRate: an unsupported Canadian province", () => {
  it("reports once, still logs the warn, and resolves no rate (inline address in ON)", async () => {
    const reportError = vi.fn();
    const logger = makeLogger();
    const taxRateLookup = makeLookup();

    const prepared = await prepareEventTaxRate(
      { clock, taxRateLookup, reportError },
      makeReader(),
      inlineRef("ON", "M5V 2T6"),
      logger,
      LOG_CONTEXT,
    );

    // No rate, and not flagged `unknown`: checkout reads this as a genuine
    // no-rate outcome, which is why it has to be reported here.
    expect(prepared).toEqual({ stamp: null, fresh: null, cacheTarget: null });
    expect(taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();

    const detail = {
      ...LOG_CONTEXT,
      locationKind: "inline",
      region: "ON",
      postalCode: "M5V 2T6",
      resolvedProvince: "ON",
    };
    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    // A stable message and `reason` tag, so occurrences are searchable together.
    expect((error as Error).message).toBe(WARN);
    expect(context).toEqual({ tags: TAGS, extra: detail });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(WARN, detail);
    // Not routed through the repo-fault path, which logs at error and rethrows.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reports a PST province on a Place row and keeps the row's address on the result", async () => {
    const reportError = vi.fn();
    const place = makePlace({ region: "BC", postalCode: "V6B 1A1" });

    const prepared = await prepareEventTaxRate(
      { clock, reportError },
      makeReader({ place }),
      PLACE_REF,
      undefined,
      LOG_CONTEXT,
    );

    expect(prepared).toEqual({
      stamp: null,
      fresh: null,
      cacheTarget: { kind: "place", placeId: PLACE_ID },
      stampAddress: { postalCode: "V6B 1A1", countryCode: "CA", region: "BC" },
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tags: TAGS,
      extra: {
        ...LOG_CONTEXT,
        locationKind: "place",
        region: "BC",
        postalCode: "V6B 1A1",
        resolvedProvince: "BC",
      },
    });
  });

  it("reports the province read from the postal code when a SavedLocation has no region", async () => {
    const reportError = vi.fn();
    const savedLocation = makeStubSavedLocationRecord({
      id: SAVED_LOCATION_ID,
      countryCode: "CA",
      region: null,
      postalCode: "K1A 0B1",
      admissionTaxRateBps: null,
    });

    const prepared = await prepareEventTaxRate(
      { clock, reportError },
      makeReader({ savedLocation }),
      { kind: "saved-location", savedLocationId: SAVED_LOCATION_ID },
      undefined,
      LOG_CONTEXT,
    );

    expect(prepared.stamp).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tags: TAGS,
      extra: {
        ...LOG_CONTEXT,
        locationKind: "saved-location",
        region: null,
        postalCode: "K1A 0B1",
        resolvedProvince: "ON",
      },
    });
  });

  it("reports a province that cannot be determined at all", async () => {
    const reportError = vi.fn();

    const prepared = await prepareEventTaxRate(
      { clock, reportError },
      makeReader(),
      inlineRef(null, "00000"),
      undefined,
    );

    expect(prepared.stamp).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toEqual({
      tags: TAGS,
      extra: {
        locationKind: "inline",
        region: null,
        postalCode: "00000",
        resolvedProvince: null,
      },
    });
  });

  it("a supported province (AB) reports nothing and logs no warn", async () => {
    const reportError = vi.fn();
    const logger = makeLogger();

    const prepared = await prepareEventTaxRate(
      { clock, reportError },
      makeReader(),
      inlineRef("AB", "T5J 0N3"),
      logger,
      LOG_CONTEXT,
    );

    expect(prepared.stamp).toEqual({
      rateBps: 500,
      source: "ca_gst_hst",
      situs: { countryCode: "CA", region: "AB", postalCode: "T5J 0N3" },
    });
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("a reporter that throws changes nothing: same result, nothing thrown", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const logger = makeLogger();
    const place = makePlace();

    const withoutReporter = await prepareEventTaxRate(
      { clock },
      makeReader({ place }),
      PLACE_REF,
      undefined,
      LOG_CONTEXT,
    );
    const withThrowingReporter = prepareEventTaxRate(
      { clock, reportError },
      makeReader({ place }),
      PLACE_REF,
      logger,
      LOG_CONTEXT,
    );

    await expect(withThrowingReporter).resolves.toEqual(withoutReporter);
    expect(withoutReporter.stamp).toBeNull();
    // The reporter was reached exactly once. An unguarded throw would land in
    // the resolver's own catch, which reports AGAIN, logs at error and rethrows.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still logs the warn and resolves no rate when no reporter is wired", async () => {
    const logger = makeLogger();

    const prepared = await prepareEventTaxRate(
      { clock },
      makeReader(),
      inlineRef("ON", "M5V 2T6"),
      logger,
    );

    expect(prepared.stamp).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toBe(WARN);
  });
});

// The in-transaction re-stamp: the stamp was prepared for one address and the
// venue has moved by the time the transaction reads the row again.
describe("commitPreparedEventTaxRate: the venue moved to an unsupported Canadian province", () => {
  const edmonton = makePlace({
    city: "Edmonton",
    region: "AB",
    postalCode: "T5J 0N3",
  });

  async function prepareForEdmonton() {
    const prepared = await prepareEventTaxRate(
      { clock },
      makeReader({ place: edmonton }),
      PLACE_REF,
      undefined,
    );
    expect(prepared.stamp?.rateBps).toBe(500);
    return prepared;
  }

  const asTx = (place: PlaceRecord) =>
    makeReader({ place }) as unknown as TxRepos;

  it("reports once, still logs the warn, and drops the stamp", async () => {
    const reportError = vi.fn();
    const logger = makeLogger();
    const prepared = await prepareForEdmonton();

    const stamp = await commitPreparedEventTaxRate(
      { reportError },
      asTx(makePlace()),
      prepared,
      logger,
      LOG_CONTEXT,
    );

    expect(stamp).toBeNull();
    const detail = {
      ...LOG_CONTEXT,
      locationKind: "place",
      region: "ON",
      postalCode: "M5H 2N2",
      resolvedProvince: "ON",
    };
    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(WARN);
    expect(context).toEqual({ tags: TAGS, extra: detail });
    expect(logger.warn).toHaveBeenCalledWith(WARN, detail);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a reporter that throws changes nothing: the stamp is still dropped, nothing thrown", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const logger = makeLogger();
    const prepared = await prepareForEdmonton();

    await expect(
      commitPreparedEventTaxRate(
        { reportError },
        asTx(makePlace()),
        prepared,
        logger,
        LOG_CONTEXT,
      ),
    ).resolves.toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("a move within supported provinces reports nothing and re-stamps from the table", async () => {
    const reportError = vi.fn();
    const prepared = await prepareForEdmonton();
    const whitehorse = makePlace({
      city: "Whitehorse",
      region: "YT",
      postalCode: "Y1A 1C2",
    });

    const stamp = await commitPreparedEventTaxRate(
      { reportError },
      asTx(whitehorse),
      prepared,
      undefined,
      LOG_CONTEXT,
    );

    expect(stamp).toEqual({
      rateBps: 500,
      source: "ca_gst_hst",
      situs: { countryCode: "CA", region: "YT", postalCode: "Y1A 1C2" },
    });
    expect(reportError).not.toHaveBeenCalled();
  });
});
