import { describe, expect, it, vi } from "vitest";

import { resolveTaxRateForEvent } from "../publish-event";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";
import type { TxRepos } from "@th/ports/repos";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

const NOW = new Date("2026-06-30T00:00:00.000Z");
const clock = { now: () => NOW };

const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const SAVED_LOCATION_ID = "00000000-0000-4000-8000-0000000000b1";

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "Venue",
    slug: "venue",
    formattedAddress: "1 Main St",
    addressLine1: "1 Main St",
    addressLine2: null,
    city: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
    addressHash: "1 main st",
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    capacity: null,
    lat: null,
    lng: null,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: true,
    acceptsBookingRequests: false,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies PlaceRecord;
}

function makeSavedLocation(
  overrides: Partial<SavedLocationRecord> = {},
): SavedLocationRecord {
  return {
    id: SAVED_LOCATION_ID,
    name: "My Place",
    address: "1 Main St",
    countryCode: "US",
    region: "TX",
    locality: "Austin",
    postalCode: "78701",
    lat: null,
    lng: null,
    ownerType: "ORGANIZATION",
    ownerId: "11111111-1111-4111-8111-111111111111",
    usageCount: 1,
    admissionTaxRateBps: null,
    taxRateFetchedAt: null,
    taxRateSource: null,
    ...overrides,
  } satisfies SavedLocationRecord;
}

type LookupResult = { rateBps: number; source: string } | null;

function makeTx(opts: {
  place?: PlaceRecord | null;
  savedLocation?: SavedLocationRecord | null;
}) {
  // The unconditional writes must never be used; the cache is filled only by
  // compare-and-set.
  const placesUpdateTaxRate = vi.fn(async () => undefined);
  const savedLocationsUpdateTaxRate = vi.fn(async () => undefined);
  const placesFillTaxRateIfUnset = vi.fn(async () => true);
  const savedLocationsFillTaxRateIfUnset = vi.fn(async () => true);
  const tx = {
    places: {
      getById: vi.fn(async () => opts.place ?? null),
      updateTaxRate: placesUpdateTaxRate,
      fillTaxRateIfUnset: placesFillTaxRateIfUnset,
    },
    savedLocations: {
      getById: vi.fn(async () => opts.savedLocation ?? null),
      updateTaxRate: savedLocationsUpdateTaxRate,
      fillTaxRateIfUnset: savedLocationsFillTaxRateIfUnset,
    },
  } as unknown as TxRepos;
  return {
    tx,
    placesUpdateTaxRate,
    savedLocationsUpdateTaxRate,
    placesFillTaxRateIfUnset,
    savedLocationsFillTaxRateIfUnset,
  };
}

function makeLookup(result: LookupResult) {
  return {
    lookupByPostalCode: vi.fn(async () => result),
  };
}

function makeEvent(overrides: Partial<EventRecord>): EventRecord {
  return makeStubEventRecord({
    placeId: null,
    savedLocationId: null,
    countryCode: null,
    postalCode: null,
    ...overrides,
  });
}

describe("resolveTaxRateForEvent", () => {
  it("uses the place's cached rate without a lookup", async () => {
    const place = makePlace({
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
    const { tx, placesUpdateTaxRate } = makeTx({ place });
    const taxRateLookup = makeLookup({ rateBps: 999, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ placeId: PLACE_ID }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 825, source: "ziptax" });
    expect(taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(placesUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("does a last-chance lookup and caches it on a place with no cached rate, by compare-and-set", async () => {
    const place = makePlace({ admissionTaxRateBps: null });
    const { tx, placesUpdateTaxRate, placesFillTaxRateIfUnset } = makeTx({
      place,
    });
    const taxRateLookup = makeLookup({ rateBps: 825, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ placeId: PLACE_ID }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 825, source: "ziptax" });
    // The venue's street address rides along so the provider can do the
    // rooftop (address) lookup before falling back to the postcode.
    expect(taxRateLookup.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "78701",
      countryCode: "US",
      street: "1 Main St",
      city: "Austin",
      region: "TX",
    });
    expect(placesFillTaxRateIfUnset).toHaveBeenCalledWith({
      id: PLACE_ID,
      expectedPostalCode: "78701",
      expectedCountryCode: "US",
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
      taxRateFetchedAt: NOW,
    });
    expect(placesUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("resolves via SavedLocation when there is no place", async () => {
    const savedLocation = makeSavedLocation({
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    });
    const { tx, savedLocationsUpdateTaxRate } = makeTx({ savedLocation });
    const taxRateLookup = makeLookup(null);

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ savedLocationId: SAVED_LOCATION_ID }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 888, source: "ziptax" });
    expect(taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(savedLocationsUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("does a last-chance lookup and caches it on a SavedLocation with no cached rate, by compare-and-set", async () => {
    const savedLocation = makeSavedLocation({ admissionTaxRateBps: null });
    const {
      tx,
      savedLocationsUpdateTaxRate,
      savedLocationsFillTaxRateIfUnset,
    } = makeTx({ savedLocation });
    const taxRateLookup = makeLookup({ rateBps: 888, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ savedLocationId: SAVED_LOCATION_ID }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 888, source: "ziptax" });
    expect(savedLocationsFillTaxRateIfUnset).toHaveBeenCalledWith({
      id: SAVED_LOCATION_ID,
      expectedPostalCode: "78701",
      expectedCountryCode: "US",
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
      taxRateFetchedAt: NOW,
    });
    expect(savedLocationsUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("prefers the place over the saved location", async () => {
    const place = makePlace({
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
    const savedLocation = makeSavedLocation({ admissionTaxRateBps: 100 });
    const { tx } = makeTx({ place, savedLocation });
    const taxRateLookup = makeLookup(null);

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ placeId: PLACE_ID, savedLocationId: SAVED_LOCATION_ID }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 825, source: "ziptax" });
    expect(tx.savedLocations.getById).not.toHaveBeenCalled();
  });

  it("falls back to the event's inline address when there is no place/saved location", async () => {
    const { tx } = makeTx({});
    const taxRateLookup = makeLookup({ rateBps: 975, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ countryCode: "US", postalCode: "90012" }),
      undefined,
    );

    expect(result).toMatchObject({ rateBps: 975, source: "ziptax" });
    expect(taxRateLookup.lookupByPostalCode).toHaveBeenCalledWith(expect.objectContaining({
      postalCode: "90012",
      countryCode: "US",
    }));
  });

  it("returns null when the event has no resolvable location", async () => {
    const { tx } = makeTx({});
    const taxRateLookup = makeLookup({ rateBps: 975, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({}),
      undefined,
    );

    expect(result).toBeNull();
    expect(taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("returns null (and does not throw) when the last-chance lookup fails", async () => {
    const place = makePlace({ admissionTaxRateBps: null });
    const { tx, placesUpdateTaxRate } = makeTx({ place });
    const taxRateLookup = {
      lookupByPostalCode: vi.fn(async () => {
        throw new Error("ziptax 500");
      }),
    };

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ placeId: PLACE_ID }),
      undefined,
    );

    expect(result).toBeNull();
    expect(placesUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("a cache another writer already filled is left alone (the compare-and-set declines)", async () => {
    const place = makePlace({ admissionTaxRateBps: null });
    const { tx, placesUpdateTaxRate, placesFillTaxRateIfUnset } = makeTx({
      place,
    });
    placesFillTaxRateIfUnset.mockResolvedValue(false);
    const taxRateLookup = makeLookup({ rateBps: 825, source: "ziptax" });

    const result = await resolveTaxRateForEvent(
      { taxRateLookup, clock },
      tx,
      makeEvent({ placeId: PLACE_ID }),
      undefined,
    );

    // Same address, so the looked-up rate is still the right stamp.
    expect(result).toMatchObject({ rateBps: 825, source: "ziptax" });
    expect(placesFillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    expect(placesUpdateTaxRate).not.toHaveBeenCalled();
  });
});
