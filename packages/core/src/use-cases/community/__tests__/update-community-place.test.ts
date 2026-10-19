import { describe, expect, it, vi } from "vitest";

import { updateCommunityPlace } from "../update-community-place";
import { resolveListingPlaceLocation } from "../_shared/resolve-listing-place";
import {
  EXISTING_PLACE_ID,
  OTHER_PLACE_ID,
  auditRows,
  buildHarness,
  makePlace,
  provisionalClaim,
  verifiedOwnership,
  type HarnessOptions,
} from "./community-place-harness";
import { MODERATOR_ID, USER_ID } from "./helpers";

/**
 * updateCommunityPlace — a moderator corrects a place NOBODY owns: the typo'd
 * "Corner Bar Suoth" becomes "Corner Bar South", in place, instead of staying
 * a public page beside a second row.
 */

const TYPO = makePlace({
  name: "Corner Bar Suoth",
  formattedAddress: "2190 Nolensville Pike, Nashville, TN 37211, USA",
  addressLine1: "2190 Nolensville Pike",
  postalCode: "37211",
  // A bulk-imported place: its website is trusted provenance.
  website: "https://cornerbar.example",
  websiteSource: "TRUSTED_IMPORT",
  phone: "+16155550100",
  capacity: 120,
});

// ~60 m north, new postcode: the corrected address and pin.
const CORRECTED = {
  formatted: "2190A Nolensville Pike, Nashville, TN 37210, USA",
  line1: "2190A Nolensville Pike",
  city: "Nashville",
  region: "TN",
  postalCode: "37210",
  countryCode: "US",
  lat: TYPO.lat! + 0.00054,
  lng: TYPO.lng!,
};

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  placeId: EXISTING_PLACE_ID,
  name: "Corner Bar South",
  address: CORRECTED,
  clientKey: "community-place-edit-1",
};

describe("updateCommunityPlace — who may, and which places", () => {
  it("refuses a non-moderator before any write", async () => {
    const h = buildHarness({ places: [TYPO] });

    await expect(
      updateCommunityPlace(h.deps, { ...BASE_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("refuses a claimed place (verified, unrevoked ownership): PLACE_HAS_OWNER", async () => {
    const h = buildHarness({
      places: [TYPO],
      verifiedOwners: { [EXISTING_PLACE_ID]: verifiedOwnership(EXISTING_PLACE_ID) },
    });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses a place an org holds access to", async () => {
    const h = buildHarness({
      places: [{ ...TYPO, orgIdsWithAccess: ["44444444-4444-4444-8444-444444444444"] }],
    });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
    });
  });

  it("re-checks under the claim lock: a claim verified meanwhile wins", async () => {
    const h = buildHarness({
      places: [TYPO],
      onClaimLock: (placeId) => {
        h.verifiedOwners.set(placeId, verifiedOwnership(placeId));
      },
    });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a place with a claim in review",
      { provisionalClaims: { [EXISTING_PLACE_ID]: provisionalClaim(EXISTING_PLACE_ID) } },
      false,
      "CLAIM_PENDING",
    ],
    ["a place whose verificationStatus is PENDING", {}, true, "CLAIM_PENDING"],
    [
      "a place an organiser's event uses (its ticket emails read the live name and address)",
      { ownedEventPlaceIds: [EXISTING_PLACE_ID] },
      false,
      "OWNED_EVENTS_AT_PLACE",
    ],
  ] as const)("refuses %s: PLACE_HAS_OWNER, reason %s", async (_label, opts, pending, reason) => {
    const h = buildHarness({
      places: [pending ? { ...TYPO, verificationStatus: "PENDING" } : TYPO],
      ...(opts as HarnessOptions),
    });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("re-checks under the claim lock: a claim submitted meanwhile wins (CLAIM_PENDING)", async () => {
    const h = buildHarness({
      places: [TYPO],
      onClaimLock: (placeId) => {
        h.provisionalClaims.set(placeId, provisionalClaim(placeId));
      },
    });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_HAS_OWNER",
      meta: { reason: "CLAIM_PENDING" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ["ARCHIVED", "PLACE_ARCHIVED"],
    ["SUSPENDED", "PLACE_NOT_ACTIVE"],
  ] as const)("refuses a %s place with %s", async (status, code) => {
    const h = buildHarness({ places: [{ ...TYPO, status }] });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code,
    });
  });

  it("refuses a place that withholds its address (never publishes a hidden one)", async () => {
    const h = buildHarness({ places: [{ ...TYPO, locationMode: "OBSCURED" }] });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "PLACE_WITHHOLDS_ADDRESS" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("PLACE_NOT_FOUND for an unknown place", async () => {
    const h = buildHarness();

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });
});

describe("updateCommunityPlace — the write", () => {
  it("corrects name, address and pin, and returns the picker fields", async () => {
    const h = buildHarness({ places: [TYPO] });

    const result = await updateCommunityPlace(h.deps, BASE_INPUT);

    expect(result).toMatchObject({
      placeId: EXISTING_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: CORRECTED.formatted,
      lat: CORRECTED.lat,
      lng: CORRECTED.lng,
      status: "ACTIVE",
    });
    const written = h.mocks.placesRepo.upsert.mock.calls[0]![0];
    expect(written.owner).toBeNull();
    expect(written.placeId).toBe(EXISTING_PLACE_ID);
  });

  it("keeps capacity, phone, the imported website and its TRUSTED_IMPORT provenance", async () => {
    const h = buildHarness({ places: [TYPO] });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      capacity: 120,
      phone: "+16155550100",
      website: "https://cornerbar.example",
      websiteSource: "TRUSTED_IMPORT",
    });
  });

  it("audits as the moderator (ownerless `updated` + `place.community_updated` from/to)", async () => {
    const h = buildHarness({ places: [TYPO] });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    const rows = auditRows(h.mocks.auditRepo.log);
    expect(rows.find((r) => r.action === "updated")!.data).toMatchObject({
      ownerless: true,
      actorHumanId: MODERATOR_ID,
      name: "Corner Bar South",
    });
    expect(
      rows.find((r) => r.action === "place.community_updated")!.data,
    ).toMatchObject({
      actorHumanId: MODERATOR_ID,
      from: { name: "Corner Bar Suoth" },
      to: { name: "Corner Bar South", formattedAddress: CORRECTED.formatted },
    });
  });

  it("the audit row carries every column the edit writes or derives, before and after (undoable from the log)", async () => {
    const h = buildHarness({
      places: [{ ...TYPO, admissionTaxRateBps: 975, taxRateSource: "ziptax", timezone: null }],
    });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    const data = auditRows(h.mocks.auditRepo.log).find(
      (r) => r.action === "place.community_updated",
    )!.data;
    expect(data.from).toEqual({
      name: "Corner Bar Suoth",
      formattedAddress: TYPO.formattedAddress,
      addressLine1: TYPO.addressLine1,
      addressLine2: TYPO.addressLine2,
      city: TYPO.city,
      region: TYPO.region,
      postalCode: "37211",
      countryCode: "US",
      lat: TYPO.lat,
      lng: TYPO.lng,
      timezone: null,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
    expect(data.to).toMatchObject({
      name: "Corner Bar South",
      formattedAddress: CORRECTED.formatted,
      addressLine1: CORRECTED.line1,
      postalCode: "37210",
      lat: CORRECTED.lat,
      timezone: "America/Chicago",
      admissionTaxRateBps: 925,
    });
  });

  it("re-looks-up the tax rate on a postcode change and re-derives the timezone on an address change", async () => {
    const timezoneLookup = vi.fn(() => "America/Chicago");
    const h = buildHarness({
      places: [{ ...TYPO, timezone: null }],
      timezoneLookup,
    });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    expect(h.mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalled();
    expect(h.rows.get(EXISTING_PLACE_ID)?.admissionTaxRateBps).toBe(925);
    expect(timezoneLookup).toHaveBeenCalledWith(CORRECTED.lat, CORRECTED.lng);
    expect(h.rows.get(EXISTING_PLACE_ID)?.timezone).toBe("America/Chicago");
  });

  it("marks the place for reindex and re-indexes it after commit", async () => {
    const h = buildHarness({ places: [TYPO], withSearch: true });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    expect(h.mocks.markSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(h.search!.upsertDocuments).toHaveBeenCalledWith({
        documents: [
          expect.objectContaining({
            type: "place",
            placeId: EXISTING_PLACE_ID,
            name: "Corner Bar South",
          }),
        ],
      }),
    );
  });

  it("leaves the place valid for a community listing (EXACT, with a pin)", async () => {
    const h = buildHarness({ places: [TYPO] });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    await expect(
      resolveListingPlaceLocation(h.deps.repos, EXISTING_PLACE_ID),
    ).resolves.toMatchObject({
      addressText: CORRECTED.formatted,
      lat: CORRECTED.lat,
    });
  });

  it("takes the locks in order: name, claim, then the place-location lock", async () => {
    const h = buildHarness({ places: [TYPO] });

    await updateCommunityPlace(h.deps, BASE_INPUT);

    const nameLock = h.order.indexOf("lockPlaceName:corner bar south");
    const claimLock = h.order.indexOf(`lockPlaceForClaim:${EXISTING_PLACE_ID}`);
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(claimLock).toBeGreaterThan(nameLock);
    expect(claimLock).toBeLessThan(h.order.indexOf("upsert"));
    expect(h.mocks.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: EXISTING_PLACE_ID,
      mode: "exclusive",
    });
  });

  it("refuses a name the content filter blocks", async () => {
    const h = buildHarness({ places: [TYPO], blocked: ["South"] });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
    });
  });

  it("replays the same clientKey without a second write", async () => {
    const h = buildHarness({ places: [TYPO] });

    const first = await updateCommunityPlace(h.deps, BASE_INPUT);
    const second = await updateCommunityPlace(h.deps, BASE_INPUT);

    expect(second).toEqual(first);
    expect(h.mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("updateCommunityPlace — duplicate guard", () => {
  it("does not count the place itself: re-saving it under its own name and pin succeeds", async () => {
    const h = buildHarness({ places: [TYPO] });

    await expect(
      updateCommunityPlace(h.deps, {
        ...BASE_INPUT,
        name: "Corner Bar Suoth",
        address: { ...CORRECTED, lat: TYPO.lat!, lng: TYPO.lng! },
      }),
    ).resolves.toMatchObject({ placeId: EXISTING_PLACE_ID });
    expect(h.finder.findActiveExactByNormalizedName).toHaveBeenCalledWith(
      expect.objectContaining({ excludePlaceId: EXISTING_PLACE_ID }),
    );
  });

  it("refuses renaming onto ANOTHER same-name place within 50 m", async () => {
    const other = makePlace({ id: OTHER_PLACE_ID, lat: CORRECTED.lat, lng: CORRECTED.lng });
    const h = buildHarness({ places: [TYPO, other] });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });
});

describe("updateCommunityPlace — name only (address omitted)", () => {
  const { address: _omitted, ...NAME_ONLY } = BASE_INPUT;

  // Every stored address column, filled, so a blanked one shows.
  const STORED = {
    ...TYPO,
    addressLine1: "2190 Nolensville Pike",
    addressLine2: "Suite 2",
    city: "Nashville",
    region: "TN",
    postalCode: "37211",
    countryCode: "US",
    timezone: "America/Chicago",
    admissionTaxRateBps: 975,
    taxRateSource: "ziptax",
  } as const;

  it("renames and keeps every stored address column exactly, with no tax or timezone lookup (a row whose addressHash matches its text)", async () => {
    const timezoneLookup = vi.fn(() => "America/Denver");
    const h = buildHarness({ places: [STORED], timezoneLookup });

    const result = await updateCommunityPlace(h.deps, NAME_ONLY);

    expect(result).toMatchObject({
      placeId: EXISTING_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: STORED.formattedAddress,
      lat: STORED.lat,
      lng: STORED.lng,
    });
    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      name: "Corner Bar South",
      formattedAddress: STORED.formattedAddress,
      addressHash: STORED.addressHash,
      addressLine1: "2190 Nolensville Pike",
      addressLine2: "Suite 2",
      city: "Nashville",
      region: "TN",
      postalCode: "37211",
      countryCode: "US",
      lat: STORED.lat,
      lng: STORED.lng,
      timezone: "America/Chicago",
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
    expect(h.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    expect(timezoneLookup).not.toHaveBeenCalled();
  });

  it("leaves a stored NULL street line NULL (never rewrites it as \"\")", async () => {
    const h = buildHarness({ places: [{ ...STORED, addressLine1: null }] });

    await updateCommunityPlace(h.deps, NAME_ONLY);

    const written = h.mocks.placesRepo.upsert.mock.calls[0]![0];
    expect(written.address).not.toHaveProperty("line1");
    expect(h.rows.get(EXISTING_PLACE_ID)?.addressLine1).toBeNull();
  });

  it("audits from/to with only the name changed", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, NAME_ONLY);

    const data = auditRows(h.mocks.auditRepo.log).find(
      (r) => r.action === "place.community_updated",
    )!.data as { from: Record<string, unknown>; to: Record<string, unknown> };
    expect(data.to).toEqual({ ...data.from, name: "Corner Bar South" });
    expect(data.from.name).toBe("Corner Bar Suoth");
  });

  it("refuses a same-name twin within 50 m of the STORED pin", async () => {
    // ~11 m north of the stored pin, different address text.
    const twin = makePlace({
      id: OTHER_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: "2192 Nolensville Pike, Nashville, TN 37211, USA",
      lat: TYPO.lat! + 0.0001,
      lng: TYPO.lng!,
    });
    const h = buildHarness({ places: [STORED, twin] });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("allows a same-name place far from the stored pin, and probes after the name and claim locks", async () => {
    const far = makePlace({
      id: OTHER_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: "1 Broadway, Nashville, TN 37203, USA",
      lat: TYPO.lat! + 0.05,
      lng: TYPO.lng!,
    });
    const h = buildHarness({ places: [STORED, far] });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).resolves.toMatchObject({
      placeId: EXISTING_PLACE_ID,
    });
    expect(h.finder.findActiveExactByNormalizedName).toHaveBeenCalledWith(
      expect.objectContaining({ excludePlaceId: EXISTING_PLACE_ID }),
    );
    const nameLock = h.order.indexOf("lockPlaceName:corner bar south");
    const claimLock = h.order.indexOf(`lockPlaceForClaim:${EXISTING_PLACE_ID}`);
    expect(nameLock).toBeGreaterThanOrEqual(0);
    expect(claimLock).toBeGreaterThan(nameLock);
    expect(claimLock).toBeLessThan(h.order.indexOf("upsert"));
  });

  it("still refuses a place that withholds its address", async () => {
    const h = buildHarness({ places: [{ ...STORED, locationMode: "OBSCURED" }] });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "PLACE_WITHHOLDS_ADDRESS" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("replays the same clientKey without a second write", async () => {
    const h = buildHarness({ places: [STORED] });

    const first = await updateCommunityPlace(h.deps, NAME_ONLY);
    const second = await updateCommunityPlace(h.deps, NAME_ONLY);

    expect(second).toEqual(first);
    expect(h.mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("a clientKey used without an address conflicts when replayed WITH one (and the reverse)", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, NAME_ONLY);
    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });

    const h2 = buildHarness({ places: [STORED] });
    await updateCommunityPlace(h2.deps, BASE_INPUT);
    await expect(updateCommunityPlace(h2.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
    });
  });

  it("a PRESENT address is written as sent: a thinner one blanks the street line and postcode (why the dialog omits it)", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, {
      ...BASE_INPUT,
      name: "Corner Bar South",
      address: {
        formatted: STORED.formattedAddress!,
        city: "Nashville",
        region: "TN",
        countryCode: "US",
        lat: STORED.lat!,
        lng: STORED.lng!,
      },
    });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      addressLine1: "",
      postalCode: null,
    });
  });

  it("a row stored with a NULL addressHash gets its hash written and its timezone re-derived from the STORED pin", async () => {
    const timezoneLookup = vi.fn(() => "America/Chicago");
    const h = buildHarness({
      places: [{ ...STORED, addressHash: null, timezone: null }],
      timezoneLookup,
    });

    await updateCommunityPlace(h.deps, NAME_ONLY);

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      addressHash: STORED.formattedAddress!.toLowerCase(),
      timezone: "America/Chicago",
      postalCode: "37211",
      admissionTaxRateBps: 975,
    });
    expect(timezoneLookup).toHaveBeenCalledWith(STORED.lat, STORED.lng);
    expect(h.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("writes the address AS COMMITTED when another edit lands before the claim lock, and probes with that pin, after the lock", async () => {
    // Another moderator's address correction commits while this rename
    // waits on the claim lock: ~600 m north, new street line and postcode.
    const MOVED = {
      formattedAddress: "2300 Nolensville Pike, Nashville, TN 37210, USA",
      addressHash: "2300 nolensville pike, nashville, tn 37210, usa",
      addressLine1: "2300 Nolensville Pike",
      postalCode: "37210",
      lat: TYPO.lat! + 0.0054,
      lng: TYPO.lng!,
    };
    let findsAtClaimLock = -1;
    const h = buildHarness({
      places: [STORED],
      onClaimLock: (placeId) => {
        findsAtClaimLock = h.finder.calls.filter((c) => c === "find").length;
        h.rows.set(placeId, { ...h.rows.get(placeId)!, ...MOVED });
      },
    });

    await updateCommunityPlace(h.deps, NAME_ONLY);

    const written = h.mocks.placesRepo.upsert.mock.calls[0]![0];
    expect(written.address).toMatchObject({
      formatted: MOVED.formattedAddress,
      line1: MOVED.addressLine1,
      postalCode: "37210",
    });
    expect(written.geo).toEqual({ lat: MOVED.lat, lng: MOVED.lng });
    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      name: "Corner Bar South",
      ...MOVED,
    });
    // The probe ran after the claim lock, never before it.
    expect(findsAtClaimLock).toBe(0);
    expect(h.finder.calls.filter((c) => c === "find").length).toBe(1);
  });

  it("the duplicate probe uses the pin committed before the claim lock, not the one read first", async () => {
    const MOVED_PIN = { lat: TYPO.lat! + 0.0054, lng: TYPO.lng! };
    // A same-name place ~11 m from the MOVED pin, ~590 m from the old one.
    const twin = makePlace({
      id: OTHER_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: "2302 Nolensville Pike, Nashville, TN 37210, USA",
      lat: MOVED_PIN.lat + 0.0001,
      lng: MOVED_PIN.lng,
    });
    const h = buildHarness({
      places: [STORED, twin],
      onClaimLock: (placeId) => {
        h.rows.set(placeId, {
          ...h.rows.get(placeId)!,
          formattedAddress: "2300 Nolensville Pike, Nashville, TN 37210, USA",
          addressHash: "2300 nolensville pike, nashville, tn 37210, usa",
          ...MOVED_PIN,
        });
      },
    });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("refuses a name-only edit of a row with no stored country (ADDRESS_INCOMPLETE), before any claim", async () => {
    const h = buildHarness({ places: [{ ...STORED, countryCode: null }] });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { placeId: EXISTING_PLACE_ID, reason: "ADDRESS_INCOMPLETE" },
    });
    expect(h.mocks.tx).not.toHaveBeenCalled();
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    expect(h.rows.get(EXISTING_PLACE_ID)?.admissionTaxRateBps).toBe(975);
  });

  it("re-checks the stored country under the claim lock", async () => {
    const h = buildHarness({
      places: [STORED],
      onClaimLock: (placeId) => {
        h.rows.set(placeId, { ...h.rows.get(placeId)!, countryCode: null });
      },
    });

    await expect(updateCommunityPlace(h.deps, NAME_ONLY)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "ADDRESS_INCOMPLETE" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("a row with no stored country can still be saved WITH a picked address", async () => {
    const h = buildHarness({ places: [{ ...STORED, countryCode: null }] });

    await expect(updateCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      placeId: EXISTING_PLACE_ID,
    });
    expect(h.rows.get(EXISTING_PLACE_ID)?.countryCode).toBe("US");
  });
});
