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
import type { EventRecord } from "@th/ports/repos/events";

// ─────────────────────────────────────────────────────────────────────────────
// Tests for the save-time admission-tax-rate stamp gate + the
// `didLocationChange` no-clobber guard in save-event-shared.ts.
//
// These cover the highest-risk money-path branch: stamping (or deliberately NOT
// re-stamping) `event.admissionTaxRateBps` when a draft is plain-Saved. The
// invariant under test is "never clobber an already-collected rate with a
// transient null", plus "stamp the new rate when the location actually changes".
//
// We assert against the `events.updateTaxRate` spy on the events fake.
// ─────────────────────────────────────────────────────────────────────────────

const A_DIFFERENT_PLACE_ID = "33333333-3333-4333-8333-3333333333a2";

type OrgInputOverrides = Partial<
  Record<"actorHumanId" | "orgId" | "title" | "clientKey" | "eventId", string> & {
    startsAt?: string;
    endsAt?: string;
    location?: Record<string, unknown>;
    instructionalAdmission?: boolean;
  }
>;

function makeOrgInput(overrides: OrgInputOverrides = {}) {
  return {
    eventId: overrides.eventId,
    actorHumanId: overrides.actorHumanId ?? DEFAULT_ACTOR_ID,
    orgId: overrides.orgId ?? DEFAULT_ORG_ID,
    title: overrides.title ?? "My Event",
    startsAt: overrides.startsAt ?? "2024-02-01T18:00:00.000Z",
    endsAt: overrides.endsAt ?? "2024-02-01T19:00:00.000Z",
    location: overrides.location ?? {},
    clientKey: overrides.clientKey ?? "idem-key-1234",
    ...(overrides.instructionalAdmission !== undefined
      ? { instructionalAdmission: overrides.instructionalAdmission }
      : {}),
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

function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "DRAFT",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2024-01-01T18:00:00.000Z"),
    endsAt: new Date("2024-01-01T18:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    agreementResaleId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    payoutTermsId: null,
    resalePayoutTermsId: null,
    placeLayoutId: null,
    currency: null,
    admissionTaxRateBps: null,
    taxRateSource: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies EventRecord;
}

describe("saveEvent admission-tax-rate stamp", () => {
  it("stamps a NEW place-based event from the place's cached rate", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({ admissionTaxRateBps: 825, taxRateSource: "ziptax" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    // Cached rate present → no provider call, stamp the cached value.
    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
  });

  it("stamps a NEW saved-location event from the saved location's cached rate", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      savedLocation: makeSavedLocation({
        admissionTaxRateBps: 888,
        taxRateSource: "ziptax",
      }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { savedLocationId: DEFAULT_SAVED_LOCATION_ID },
      }),
    );

    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    });
  });

  it("does NOT restamp when the location is unchanged and a rate already exists (no-clobber)", async () => {
    const existingEvent = makeExistingEvent({
      placeId: DEFAULT_PLACE_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
    const { deps, mocks } = makeCreateEventTestContext({
      existingEvent,
      place: makePlace({ admissionTaxRateBps: 825, taxRateSource: "ziptax" }),
    });

    // Force a transient lookup failure to prove we never even reach a lookup
    // (and therefore can't null out the already-collected rate).
    mocks.taxRateLookup.lookupByPostalCode.mockRejectedValue(
      new Error("ziptax 500"),
    );

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        title: "Renamed but same venue",
        location: { placeId: DEFAULT_PLACE_ID },
      }),
    );

    expect(result.status).toBe("DRAFT");
    expect(mocks.events.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("restamps when the place changes (place A → place B)", async () => {
    const existingEvent = makeExistingEvent({
      placeId: DEFAULT_PLACE_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
    // No `place` override → the default fake returns an accessible place with a
    // null cached rate for ANY id, so switching to place B forces a fresh
    // last-chance lookup. Pin the provider to a distinct rate to prove the new
    // venue's rate is what gets stamped.
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });
    mocks.taxRateLookup.lookupByPostalCode.mockResolvedValue({
      rateBps: 975,
      source: "ziptax",
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        location: { placeId: A_DIFFERENT_PLACE_ID },
      }),
    );

    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
  });

  it("does NOT restamp a freeform re-save at the same already-linked address", async () => {
    const existingEvent = makeExistingEvent({
      savedLocationId: DEFAULT_SAVED_LOCATION_ID,
      addressText: "1 Main St, Austin, TX 78701",
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    });
    const { deps, mocks } = makeCreateEventTestContext({ existingEvent });

    // The freeform address normalizes to the SavedLocation already linked to
    // the event, so the location is unchanged.
    mocks.savedLocations.findByOwnerAndAddress.mockResolvedValue(
      makeSavedLocation({
        id: DEFAULT_SAVED_LOCATION_ID,
        admissionTaxRateBps: 888,
        taxRateSource: "ziptax",
      }),
    );
    mocks.taxRateLookup.lookupByPostalCode.mockRejectedValue(
      new Error("ziptax 500"),
    );

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({
        eventId: DEFAULT_EVENT_ID,
        location: {
          addressText: "1 Main St, Austin, TX 78701",
          lat: 30.2672,
          lng: -97.7431,
          postalCode: "78701",
          countryCode: "US",
        },
      }),
    );

    expect(result.status).toBe("DRAFT");
    // Unchanged location + existing rate → no restamp, and the existing SL is
    // reused (not re-created), so usage isn't bumped either.
    expect(mocks.events.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.savedLocations.incrementUsage).not.toHaveBeenCalled();
    expect(mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("stamps 0 / exempt:tn-instruction for an instructional TN event (exemption)", async () => {
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({
        region: "TN",
        city: "Nashville",
        postalCode: "37203",
        admissionTaxRateBps: 925,
        taxRateSource: "ziptax",
      }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { placeId: DEFAULT_PLACE_ID },
        instructionalAdmission: true,
      }),
    );

    // The venue's cached TN rate is resolved, then zeroed by the instruction
    // exemption before the stamp is written.
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 0,
      taxRateSource: "exempt:tn-instruction",
    });
  });

  it("does NOT exempt an instructional event outside TN (normal rate stamped)", async () => {
    // Default place region is TX — the flag must NOT zero a non-TN rate.
    const { deps, mocks } = makeCreateEventTestContext({
      place: makePlace({ admissionTaxRateBps: 825, taxRateSource: "ziptax" }),
    });

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: { placeId: DEFAULT_PLACE_ID },
        instructionalAdmission: true,
      }),
    );

    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
  });

  it("still saves and stamps null when the lookup fails on a NEW event", async () => {
    // Default place fake has a null cached rate → forces a last-chance lookup,
    // which we make throw. The failure must be swallowed: the event saves and
    // the rate is stamped null (checkout falls back to zero tax).
    const { deps, mocks } = makeCreateEventTestContext();
    mocks.taxRateLookup.lookupByPostalCode.mockRejectedValue(
      new Error("ziptax 500"),
    );

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    expect(result.status).toBe("DRAFT");
    expect(mocks.events.updateTaxRate).toHaveBeenCalledTimes(1);
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-1 (docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md):
// the admission-tax lookup is a live third-party HTTP call (ZipTax, 5s
// timeout). It must run BEFORE `repos.tx` opens, while every DB write it
// produces (the cache onto Place / SavedLocation, the stamp onto the Event)
// stays INSIDE the transaction so a rolled-back save leaves nothing behind.
//
// The fakes have no rollback, so "writes stay in-tx" is asserted as ORDER: the
// provider call precedes `tx-open`, and every cache write sits strictly
// between `tx-open` and `tx-close`.
//
// A CREATE runs a second, separate transaction after the save commits
// (`assignSlugOnCreate`). The recorder labels it `post-commit-tx-*` so the
// sequences below say exactly which transaction the tax I/O sits in.
// ─────────────────────────────────────────────────────────────────────────────

const SLUG_TX = ["post-commit-tx-open", "post-commit-tx-close"] as const;

type SeqDeps = ReturnType<typeof makeCreateEventTestContext>["deps"];
type SeqMocks = ReturnType<typeof makeCreateEventTestContext>["mocks"];

/**
 * Instrument the tx boundary + the provider + the two cache writes so a test
 * can assert their relative order. Returns the shared sequence array.
 */
function recordSequence(
  deps: SeqDeps,
  mocks: SeqMocks,
  lookup: () => Promise<{ rateBps: number; source: string } | null>,
): string[] {
  const seq: string[] = [];
  const originalTx = deps.repos.tx;
  let txCount = 0;
  deps.repos.tx = async (fn) => {
    const label = txCount++ === 0 ? "tx" : "post-commit-tx";
    seq.push(`${label}-open`);
    try {
      return await originalTx(fn);
    } finally {
      seq.push(`${label}-close`);
    }
  };
  mocks.taxRateLookup.lookupByPostalCode.mockImplementation(async () => {
    seq.push("lookup");
    return lookup();
  });
  // The save caches by compare-and-set (`fillTaxRateIfUnset`), because its
  // read ran before the transaction. Wrap the harness's CAS fakes rather than
  // replacing them, so a skipped write still reads as skipped. The
  // unconditional `updateTaxRate` is recorded too: it must never appear.
  const placeFill = mocks.places.fillTaxRateIfUnset.getMockImplementation()!;
  mocks.places.fillTaxRateIfUnset.mockImplementation(async (input) => {
    seq.push("place-cache-write");
    return placeFill(input);
  });
  const savedFill =
    mocks.savedLocations.fillTaxRateIfUnset.getMockImplementation()!;
  mocks.savedLocations.fillTaxRateIfUnset.mockImplementation(async (input) => {
    seq.push("saved-location-cache-write");
    return savedFill(input);
  });
  mocks.places.updateTaxRate.mockImplementation(async () => {
    seq.push("place-UNCONDITIONAL-cache-write");
  });
  mocks.savedLocations.updateTaxRate.mockImplementation(async () => {
    seq.push("saved-location-UNCONDITIONAL-cache-write");
  });
  return seq;
}

function freeformAustin(overrides: Record<string, unknown> = {}) {
  return {
    addressText: "500 Congress Ave, Austin, TX 78701",
    lat: 30.2672,
    lng: -97.7431,
    locality: "Austin",
    region: "TX",
    postalCode: "78701",
    countryCode: "US",
    ...overrides,
  };
}

describe("saveEvent admission-tax-rate: lookup runs BEFORE the transaction (P-1)", () => {
  // FAILED FIRST on the in-tx ordering: ["tx-open", "lookup", ...].
  it("place with an empty cache: provider call precedes tx-open; cache write sits inside the tx", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    expect(seq).toEqual([
      "lookup",
      "tx-open",
      "place-cache-write",
      "tx-close",
      ...SLUG_TX,
    ]);
    expect(mocks.places.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: DEFAULT_PLACE_ID,
      expectedPostalCode: "12345",
      expectedCountryCode: "US",
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      taxRateFetchedAt: deps.clock.now(),
    });
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
  });

  // FAILED FIRST twice over: the order, and the missing `reportError` on the
  // swallow (it was a bare `logger.warn`, which Sentry does not capture).
  it("provider failure is swallowed pre-tx: the event still saves with a null stamp and the swallow is reported", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => {
      throw new Error("ziptax 500");
    });

    const result = await saveEventForOrg(
      deps,
      makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
    );

    expect(result.status).toBe("DRAFT");
    expect(seq).toEqual(["lookup", "tx-open", "tx-close", ...SLUG_TX]);
    expect(mocks.places.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "lookupAdmissionTaxRate" }),
        // The default fake place's postal code, plus the resolver's context.
        extra: expect.objectContaining({
          postalCode: "12345",
          locationKind: "place",
        }),
      }),
    );
  });

  // FAILED FIRST on the order AND on the stamp: with the row minted in-tx the
  // old code re-read it through `getById`, which the fake cannot serve for a
  // brand-new id, so the stamp came out null under fakes (in production the
  // same-tx read saw the row). Resolving from the inline address pre-tx makes
  // the stamp a function of the address, not of a re-read.
  it("freeform NEW SavedLocation: resolved by postal code pre-tx, cached onto the new row in-tx, stamp matches", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: freeformAustin() }),
    );

    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "78701",
      countryCode: "US",
    });
    expect(seq).toEqual([
      "lookup",
      "tx-open",
      "saved-location-cache-write",
      "tx-close",
      ...SLUG_TX,
    ]);

    expect(mocks.savedLocations.create).toHaveBeenCalledTimes(1);
    const created = await mocks.savedLocations.create.mock.results[0]!.value;
    expect(mocks.savedLocations.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: created.id,
      expectedPostalCode: "78701",
      expectedCountryCode: "US",
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      taxRateFetchedAt: deps.clock.now(),
    });
    expect(mocks.events.linkSavedLocation).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      savedLocationId: created.id,
    });
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
  });

  // FAILED FIRST on the order only.
  it("freeform EXISTING SavedLocation with an empty cache: looked up pre-tx, cache written onto that row in-tx", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    mocks.savedLocations.findByOwnerAndAddress.mockResolvedValue(
      makeSavedLocation({ admissionTaxRateBps: null, taxRateSource: null }),
    );
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: freeformAustin() }),
    );

    expect(seq).toEqual([
      "lookup",
      "tx-open",
      "saved-location-cache-write",
      "tx-close",
      ...SLUG_TX,
    ]);
    expect(mocks.savedLocations.create).not.toHaveBeenCalled();
    // The pre-tx read resolved through the row by id; the harness's `getById`
    // serves its default row (postal "12345"), so that is the address the
    // lookup was made for and the CAS expects.
    expect(mocks.savedLocations.fillTaxRateIfUnset).toHaveBeenCalledWith({
      id: DEFAULT_SAVED_LOCATION_ID,
      expectedPostalCode: "12345",
      expectedCountryCode: "US",
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
      taxRateFetchedAt: deps.clock.now(),
    });
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
  });

  // Passed on the old code too — guards the pre-tx address read against
  // regressing "an already-cached address costs no provider call".
  it("freeform EXISTING SavedLocation with a cached rate: no provider call, no cache write, stamp from the cache", async () => {
    // The address resolves through its row, which the resolver re-reads by id
    // (as the in-tx resolver always did). The fake's `getById` is not linked
    // to `findByOwnerAndAddress`, so hand it the same cached row the real
    // adapter would return for that id.
    const cachedRow = makeSavedLocation({
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    });
    const { deps, mocks } = makeCreateEventTestContext({
      savedLocation: cachedRow,
    });
    mocks.savedLocations.findByOwnerAndAddress.mockResolvedValue(cachedRow);
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({ location: freeformAustin() }),
    );

    expect(seq).toEqual(["tx-open", "tx-close", ...SLUG_TX]);
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 888,
      taxRateSource: "ziptax",
    });
  });

  // FAILED FIRST: the old code sent the Canadian address to the provider (a
  // wasted call — ZipTax is US-only and answers null) before the resolver's
  // static-table branch produced the stamp. Pre-tx resolution takes the
  // static branch directly: same stamp, zero provider calls, no cache write.
  it("freeform NEW SavedLocation in Canada: static GST stamp, no provider call, no cache write", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: freeformAustin({
          addressText: "10 Jasper Ave, Edmonton, AB T5J 0N3",
          locality: "Edmonton",
          region: "AB",
          postalCode: "T5J 0N3",
          countryCode: "CA",
          lat: 53.5461,
          lng: -113.4938,
        }),
      }),
    );

    expect(seq).toEqual(["tx-open", "tx-close", ...SLUG_TX]);
    expect(mocks.savedLocations.create).toHaveBeenCalledTimes(1);
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
    });
  });

  // FAILED FIRST on the hoist as first written: the not-yet-saved address
  // went through `eventTaxRateLocationRef`, whose inline arm needs BOTH postal
  // code and country, so a Canadian address without a postal code resolved to
  // "no location" and stamped null. The old in-tx path hydrated the minted row
  // ({ countryCode: "CA", region: "AB", postalCode: null }) and took the
  // static-table branch. The inline ref must tolerate nulls the way the row
  // did.
  it("freeform NEW SavedLocation in Canada WITHOUT a postal code: static GST stamp from the region, no provider call", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: freeformAustin({
          addressText: "10 Jasper Ave, Edmonton, AB",
          locality: "Edmonton",
          region: "AB",
          postalCode: undefined,
          countryCode: "CA",
          lat: 53.5461,
          lng: -113.4938,
        }),
      }),
    );

    expect(seq).toEqual(["tx-open", "tx-close", ...SLUG_TX]);
    expect(mocks.savedLocations.create).toHaveBeenCalledTimes(1);
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: 500,
      taxRateSource: "ca_gst_hst",
    });
  });

  // Passed on old and new: a US address with no postal code has nothing to
  // look up (the provider gate inside `lookupAdmissionTaxRate` needs both
  // postal code and country), so the stamp is null and no provider call is
  // made. Pinned so the inline-ref change above cannot widen it.
  it("freeform NEW SavedLocation in the US WITHOUT a postal code: null stamp, no provider call", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));

    await saveEventForOrg(
      deps,
      makeOrgInput({
        location: freeformAustin({
          addressText: "500 Congress Ave, Austin, TX",
          postalCode: undefined,
        }),
      }),
    );

    expect(seq).toEqual(["tx-open", "tx-close", ...SLUG_TX]);
    expect(mocks.savedLocations.updateTaxRate).not.toHaveBeenCalled();
    expect(mocks.events.updateTaxRate).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
  });

  // FAILED FIRST on the order. The rollback half is asserted as placement:
  // the cache write is between tx-open and tx-close and NOTHING tax-related
  // was written before tx-open, so a real rollback discards it with the rest.
  it("a later in-tx write failing leaves the cache write inside the (rolled-back) tx and nothing before it", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    mocks.events.updateTaxRate.mockImplementation(async () => {
      seq.push("event-stamp");
      throw new Error("simulated write failure after the cache write");
    });

    await expect(
      saveEventForOrg(
        deps,
        makeOrgInput({ location: { placeId: DEFAULT_PLACE_ID } }),
      ),
    ).rejects.toThrow("simulated write failure");

    expect(seq).toEqual([
      "lookup",
      "tx-open",
      "place-cache-write",
      "event-stamp",
      "tx-close",
    ]);
    expect(seq.indexOf("place-cache-write")).toBeGreaterThan(
      seq.indexOf("tx-open"),
    );
    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  // Passed on the old code too — the replay short-circuit sits above the
  // pre-tx resolution, so a replayed clientKey must never re-run the lookup.
  it("an idempotent replay does not re-run the provider lookup", async () => {
    const { deps, mocks } = makeCreateEventTestContext();
    const seq = recordSequence(deps, mocks, async () => ({
      rateBps: 975,
      source: "ziptax",
    }));
    const input = makeOrgInput({
      location: { placeId: DEFAULT_PLACE_ID },
      clientKey: "replay-key-0001",
    });

    const first = await saveEventForOrg(deps, input);
    const second = await saveEventForOrg(deps, input);

    expect(second.eventId).toBe(first.eventId);
    expect(mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(seq).toEqual([
      "lookup",
      "tx-open",
      "place-cache-write",
      "tx-close",
      ...SLUG_TX,
    ]);
  });
});
