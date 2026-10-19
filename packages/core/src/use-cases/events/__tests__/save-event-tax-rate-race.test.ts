import { describe, expect, it, vi } from "vitest";

import { saveEventForOrg } from "../save-event-for-org";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  DEFAULT_SAVED_LOCATION_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SavedLocationRecord } from "@th/ports/repos/saved-locations";

// ─────────────────────────────────────────────────────────────────────────────
// The save's tax-rate READ runs before its transaction (spec 2026-09-05 P-1);
// its WRITES run inside it. Anything that changes the backing row in between
// must not be overwritten with the rate looked up for the row's OLD state:
//
//   save: prepare (Place at P1, cache empty → provider → R1)
//   upsertPlace: commits address P2 + cached R2          ← between the two
//   save: tx commits
//
// Before the fix the tx wrote `places.updateTaxRate(R1)` unconditionally (the
// venue now sits at P2 holding P1's rate, so every later checkout there
// collects the wrong tax) and stamped the event R1.
//
// The interleaving is driven from inside the fake provider: by the time the
// lookup answers, the "concurrent" edit has committed. The fakes' cache writes
// mutate the row object, so the assertions read the row's end state.
// ─────────────────────────────────────────────────────────────────────────────

const R1 = { rateBps: 825, source: "ziptax" };
const R2 = { rateBps: 700, source: "ziptax" };
const FETCHED_AT_R2 = new Date("2024-01-15T00:00:00.000Z");

function makeOrgInput(location: Record<string, unknown>) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "My Event",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T19:00:00.000Z",
    location,
    clientKey: "idem-key-race-0001",
  };
}

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: DEFAULT_PLACE_ID,
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
    orgIdsWithAccess: [DEFAULT_ORG_ID],
    humanIdsWithAccess: [DEFAULT_ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PlaceRecord;
}

function makeSavedLocation(
  overrides: Partial<SavedLocationRecord> = {},
): SavedLocationRecord {
  return {
    id: DEFAULT_SAVED_LOCATION_ID,
    name: "My Place",
    address: "1 Main St, Austin, TX 78701",
    countryCode: "US",
    region: "TX",
    locality: "Austin",
    postalCode: "78701",
    lat: null,
    lng: null,
    ownerType: "ORGANIZATION",
    ownerId: DEFAULT_ORG_ID,
    usageCount: 1,
    admissionTaxRateBps: null,
    taxRateFetchedAt: null,
    taxRateSource: null,
    ...overrides,
  } satisfies SavedLocationRecord;
}

type Ctx = ReturnType<typeof makeCreateEventTestContext>;

/**
 * Make the fakes' UNCONDITIONAL cache writes behave like the adapter (mutate
 * the row), so a clobber shows up in the row's end state, not only in a spy.
 */
function unconditionalWritesMutate(
  mocks: Ctx["mocks"],
  rows: { place?: PlaceRecord; savedLocation?: SavedLocationRecord },
) {
  mocks.places.updateTaxRate.mockImplementation(async (input) => {
    if (rows.place && rows.place.id === input.id) {
      rows.place.admissionTaxRateBps = input.admissionTaxRateBps;
      rows.place.taxRateSource = input.taxRateSource;
      rows.place.taxRateFetchedAt = input.taxRateFetchedAt;
    }
  });
  mocks.savedLocations.updateTaxRate.mockImplementation(async (input) => {
    if (rows.savedLocation && rows.savedLocation.id === input.id) {
      rows.savedLocation.admissionTaxRateBps = input.admissionTaxRateBps;
      rows.savedLocation.taxRateSource = input.taxRateSource;
      rows.savedLocation.taxRateFetchedAt = input.taxRateFetchedAt;
    }
  });
}

describe("saveEvent tax rate: the row changes between the pre-tx read and the tx", () => {
  it("place moved to a new postcode (upsertPlace cached R2): the save neither clobbers R2 nor stamps the old address's rate", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      // upsertPlace commits while the save is waiting on the provider.
      place.postalCode = "73301";
      place.addressHash = "9 other st";
      place.admissionTaxRateBps = R2.rateBps;
      place.taxRateSource = R2.source;
      place.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledWith(expect.objectContaining({
      postalCode: "78701",
      countryCode: "US",
    }));
    // The venue keeps the rate cached for its CURRENT address.
    expect(place).toMatchObject({
      postalCode: "73301",
      admissionTaxRateBps: R2.rateBps,
      taxRateFetchedAt: FETCHED_AT_R2,
    });
    expect(mocks.places.updateTaxRate).not.toHaveBeenCalled();
    // The event is stamped from the row as it is NOW, never with R1.
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("place moved and the new address has NO cached rate yet: no cache write, the event is left unstamped (NULL) for checkout to resolve", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      // upsertPlace moved it, and its own lookup for P2 came back empty.
      place.postalCode = "73301";
      return R1;
    });

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    expect(place.admissionTaxRateBps).toBeNull();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    // No provider call inside the transaction to "fix it up".
    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("place moved to a TN postcode with a cached rate: the TN instruction exemption still applies to the re-resolved stamp", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      place.postalCode = "37203";
      place.region = "TN";
      place.admissionTaxRateBps = 925;
      place.taxRateSource = "ziptax";
      return R1;
    });

    await saveEventForOrg(deps, {
      ...makeOrgInput({ placeId: DEFAULT_PLACE_ID }),
      instructionalAdmission: true,
    });

    expect(place.admissionTaxRateBps).toBe(925);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 0,
      taxRateSource: "exempt:tn-instruction",
    });
  });

  it("CACHE HIT: place moved after the pre-tx read saw its cached rate: the event is stamped with the new address's rate, not the old one", async () => {
    // No provider call at all: the venue already had R1 cached for P1, so
    // `fresh` is null and only the in-tx re-check can notice the move (a
    // re-check gated on `fresh` would not).
    const place = makePlace({
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    // upsertPlace commits P2 + R2 after every pre-tx read (the attachability
    // check AND the tax prepare both read P1/R1) and before the save's tx.
    // Hooked on the tx entry rather than a one-shot `getById`, because the
    // attachability check is the FIRST place read, ahead of the tax prepare.
    const originalTx = deps.repos.tx;
    let moved = false;
    deps.repos.tx = async (fn, options) => {
      if (!moved) {
        moved = true;
        place.postalCode = "73301";
        place.addressHash = "9 other st";
        place.admissionTaxRateBps = R2.rateBps;
        place.taxRateSource = R2.source;
        place.taxRateFetchedAt = FETCHED_AT_R2;
      }
      return originalTx(fn, options);
    };
    // Snapshot what each read returned, so the test can prove the tax
    // prepare really saw P1/R1 (the race), not the already-moved row.
    const seen: Array<{ postalCode: string | null; rateBps: number | null }> =
      [];
    mocks.places.getById.mockImplementation(async () => {
      seen.push({
        postalCode: place.postalCode,
        rateBps: place.admissionTaxRateBps,
      });
      return place;
    });

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    // Both pre-tx reads (attachability + tax prepare) saw P1 with R1 cached.
    expect(seen.slice(0, 2)).toEqual([
      { postalCode: "78701", rateBps: R1.rateBps },
      { postalCode: "78701", rateBps: R1.rateBps },
    ]);
    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(mocks.places.updateTaxRate).not.toHaveBeenCalled();
    expect(place).toMatchObject({
      postalCode: "73301",
      admissionTaxRateBps: R2.rateBps,
    });
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
  });

  it("the stamp's in-tx re-read runs AFTER the shared place-location lock (upsertPlace takes it EXCLUSIVE)", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    mocks.taxRateLookup.lookupByPostalCode.mockResolvedValue(R1);

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    const lock = vi.mocked(mocks.events.lockLocationsAtPlace);
    expect(lock).toHaveBeenCalledWith({
      placeId: DEFAULT_PLACE_ID,
      mode: "shared",
    });
    // The stamp block's re-check must sit between the lock and the stamp
    // write.
    // (Later venue-trust code reads the place again, so the stamp's read is
    // the last one BEFORE the stamp write, not the last one overall.)
    const stampWrite = vi.mocked(mocks.events.updateTaxRate).mock
      .invocationCallOrder[0]!;
    const readsBeforeStamp = mocks.places.getById.mock.invocationCallOrder.filter(
      (order) => order < stampWrite,
    );
    const stampRead = readsBeforeStamp[readsBeforeStamp.length - 1]!;
    expect(lock.mock.invocationCallOrder[0]!).toBeLessThan(stampRead);
    expect(stampRead).toBeLessThan(stampWrite);
  });

  it("same address, but a checkout's self-heal filled the cache in between: the save does not overwrite it", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      place.admissionTaxRateBps = 830;
      place.taxRateSource = "ziptax";
      place.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    expect(place).toMatchObject({
      admissionTaxRateBps: 830,
      taxRateFetchedAt: FETCHED_AT_R2,
    });
    expect(mocks.places.updateTaxRate).not.toHaveBeenCalled();
    // Same address: the rate looked up for it is a correct stamp.
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
  });

  it("same address, nothing in between: the fresh rate is cached onto the place and stamped", async () => {
    const place = makePlace();
    const { deps, mocks } = makeCreateEventTestContext({ place });
    unconditionalWritesMutate(mocks, { place });
    mocks.taxRateLookup.lookupByPostalCode.mockResolvedValue(R1);

    await saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID }));

    expect(mocks.places.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: DEFAULT_PLACE_ID,
      expectedPostalCode: "78701",
      expectedCountryCode: "US",
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
      taxRateFetchedAt: deps.clock.now(),
    });
    expect(place).toMatchObject({
      postalCode: "78701",
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
  });

  it("saved location: a rate filled in between is not overwritten", async () => {
    const savedLocation = makeSavedLocation();
    const { deps, mocks } = makeCreateEventTestContext({ savedLocation });
    unconditionalWritesMutate(mocks, { savedLocation });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      savedLocation.admissionTaxRateBps = 830;
      savedLocation.taxRateSource = "ziptax";
      savedLocation.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ savedLocationId: DEFAULT_SAVED_LOCATION_ID }),
    );

    expect(savedLocation).toMatchObject({
      admissionTaxRateBps: 830,
      taxRateFetchedAt: FETCHED_AT_R2,
    });
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
  });

  // Defensive: SavedLocation addresses are immutable today (the repo has no
  // address update), so only a cache fill can race a save in production.
  it("saved location whose postcode changed in between: no clobber, stamped from the row as it is now", async () => {
    const savedLocation = makeSavedLocation();
    const { deps, mocks } = makeCreateEventTestContext({ savedLocation });
    unconditionalWritesMutate(mocks, { savedLocation });
    mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
      savedLocation.postalCode = "73301";
      savedLocation.admissionTaxRateBps = R2.rateBps;
      savedLocation.taxRateSource = R2.source;
      return R1;
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ savedLocationId: DEFAULT_SAVED_LOCATION_ID }),
    );

    expect(savedLocation).toMatchObject({
      postalCode: "73301",
      admissionTaxRateBps: R2.rateBps,
    });
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
  });

  it("a repo fault in the conditional cache write is reported and fails the save (never read as 'no tax')", async () => {
    const { deps, mocks } = makeCreateEventTestContext({ place: makePlace() });
    mocks.taxRateLookup.lookupByPostalCode.mockResolvedValue(R1);
    const boom = new Error("connection reset during fillTaxRateIfUnset");
    mocks.places.fillTaxRateIfUnset.mockRejectedValue(boom);

    await expect(
      saveEventForOrg(deps, makeOrgInput({ placeId: DEFAULT_PLACE_ID })),
    ).rejects.toThrow(boom.message);

    expect(mocks.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "resolveEventTaxRate" }),
        extra: expect.objectContaining({ eventId: DEFAULT_EVENT_ID }),
      }),
    );
    expect(mocks.events.updateTaxRate).not.toHaveBeenCalled();
  });

  it("freeform address minted in this save: the fresh rate still lands on the new row", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    mocks.taxRateLookup.lookupByPostalCode.mockResolvedValue(R1);

    await saveEventForOrg(
      deps,
      makeOrgInput({
        addressText: "500 Congress Ave, Austin, TX 78701",
        lat: 30.2672,
        lng: -97.7431,
        locality: "Austin",
        region: "TX",
        postalCode: "78701",
        countryCode: "US",
      }),
    );

    expect(mocks.savedLocations.create).toHaveBeenCalledTimes(1);
    const minted: SavedLocationRecord =
      await mocks.savedLocations.create.mock.results[0]!.value;
    expect(mocks.savedLocations.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: minted.id,
      expectedPostalCode: "78701",
      expectedCountryCode: "US",
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
      taxRateFetchedAt: deps.clock.now(),
    });
    expect(minted.admissionTaxRateBps).toBe(R1.rateBps);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
  });
});
