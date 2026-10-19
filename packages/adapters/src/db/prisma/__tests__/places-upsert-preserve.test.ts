import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

const PLACE_ID = "place-1";

const UPDATED_ROW = {
  id: PLACE_ID,
  name: "The Fillmore",
  slug: "the-fillmore",
  address: "1805 Geary Blvd",
  addrLine1: "1805 Geary Blvd",
  addrLine2: null,
  city: "San Francisco",
  region: "CA",
  postcode: "94115",
  country: "US",
  addressHash: "1805 geary blvd",
  admissionTaxRateBps: null,
  taxRateSource: null,
  taxRateFetchedAt: null,
  capacity: 1200,
  lat: null,
  lng: null,
  phone: "+14155551234",
  website: "https://thefillmore.com",
  websiteSource: "TRUSTED_IMPORT",
  status: "ACTIVE",
  verification: "PENDING",
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  listedInDirectory: false,
  acceptsBookingRequests: false,
  locationMode: "OBSCURED",
  locationRadiusMeters: null,
  locationLabel: "East Nashville",
  attendeeReviewsPublic: false,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

function makePrisma() {
  const update = vi.fn(async () => UPDATED_ROW);
  const create = vi.fn(async () => UPDATED_ROW);
  const p = {
    place: {
      update,
      create,
      findUnique: vi.fn(async () => UPDATED_ROW),
    },
    placeOwnership: { findMany: vi.fn(async () => []), upsert: vi.fn() },
  } as unknown as PrismaClientOrTx;
  return { p, update, create };
}

const BASE_UPSERT = {
  placeId: PLACE_ID,
  name: "The Fillmore",
  address: {
    formatted: "1805 Geary Blvd",
    line1: "1805 Geary Blvd",
    line2: null,
    city: "San Francisco",
    region: "CA",
    postalCode: "94115",
    countryCode: "US",
  },
  capacity: 1200,
  status: "ACTIVE" as const,
  verificationStatus: "PENDING" as const,
};

describe("makePlacesRepo.upsert — website/phone preservation (regression)", () => {
  it("does NOT null website/phone when the caller omits those keys (claim submit + review)", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    // Mirrors the claim submit / verification review upsert: rebuild the place
    // from a record to flip ONLY verificationStatus, omitting website + phone.
    await repo.upsert(BASE_UPSERT);

    const data = update.mock.calls[0]![0].data;
    expect("website" in data).toBe(false);
    expect("phone" in data).toBe(false);
    expect(data.verification).toBe("PENDING");
  });

  it("still writes website/phone when the caller explicitly provides them", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    await repo.upsert({
      ...BASE_UPSERT,
      website: "https://newsite.com",
      phone: "+14155559999",
    });

    const data = update.mock.calls[0]![0].data;
    expect(data.website).toBe("https://newsite.com");
    expect(data.phone).toBe("+14155559999");
  });

  it("an explicit null clears website (deliberate clear still works)", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    await repo.upsert({ ...BASE_UPSERT, website: null });

    const data = update.mock.calls[0]![0].data;
    expect("website" in data).toBe(true);
    expect(data.website).toBeNull();
  });
});

// The same rebuild-to-flip-one-field hazard the website/phone guards above
// were written for applied to EVERY other optional column too, because they
// coerced `undefined` to `null`. Two real callers proved it:
//   • `toggle-place-directory-listing` omits `geo` → wiped lat/lng, i.e. the
//     venue's map pin, directions link and location-search position.
//   • `set-default-payout-terms` rebuilds from only formatted/line1/
//     countryCode → nulled city/region/postcode/capacity, reset an ARCHIVED
//     venue to ACTIVE, and demoted a VERIFIED venue to UNVERIFIED (which
//     gates visibility in `listAccessibleByHuman`).
// Prisma already means "skip" by `undefined` and "write NULL" by `null`; these
// pin that we no longer collapse the two.
describe("makePlacesRepo.upsert — omitted fields are preserved, not nulled", () => {
  it("does NOT touch geo/capacity/status/verification when the caller omits them", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    // Mirrors set-default-payout-terms: rebuild from the bare minimum to flip
    // an unrelated field. Everything omitted must survive untouched.
    await repo.upsert({
      placeId: BASE_UPSERT.placeId,
      name: BASE_UPSERT.name,
      orgId: BASE_UPSERT.orgId,
      address: {
        formatted: BASE_UPSERT.address.formatted,
        line1: BASE_UPSERT.address.line1,
        countryCode: BASE_UPSERT.address.countryCode,
      },
    });

    const data = update.mock.calls[0]![0].data;
    expect(data.lat).toBeUndefined();
    expect(data.lng).toBeUndefined();
    expect(data.capacity).toBeUndefined();
    // The sharp end: these two previously reset to ACTIVE / UNVERIFIED,
    // resurrecting archived venues and silently un-verifying verified ones.
    expect(data.status).toBeUndefined();
    expect(data.verification).toBeUndefined();
    // Address parts the caller didn't re-send must not be cleared either.
    expect(data.city).toBeUndefined();
    expect(data.region).toBeUndefined();
    expect(data.postcode).toBeUndefined();
    expect(data.addrLine2).toBeUndefined();
  });

  it("still writes every field when the caller does provide it", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    await repo.upsert({ ...BASE_UPSERT, geo: { lat: 37.7849, lng: -122.4394 } });

    const data = update.mock.calls[0]![0].data;
    expect(data.lat).toBe(37.7849);
    expect(data.lng).toBe(-122.4394);
    expect(data.capacity).toBe(1200);
    expect(data.status).toBe("ACTIVE");
    expect(data.verification).toBe("PENDING");
    expect(data.city).toBe("San Francisco");
  });

  it("an explicit null still clears coordinates and nullable address parts", async () => {
    const { p, update } = makePrisma();
    const repo = makePlacesRepo(p);

    await repo.upsert({
      ...BASE_UPSERT,
      geo: null,
      address: { ...BASE_UPSERT.address, city: null },
    });

    const data = update.mock.calls[0]![0].data;
    expect("lat" in data).toBe(true);
    expect(data.lat).toBeNull();
    expect(data.lng).toBeNull();
    expect(data.city).toBeNull();
  });

  it("omitting status/verification on CREATE is safe — Prisma @default supplies them", async () => {
    const { p, create } = makePrisma();
    const repo = makePlacesRepo(p);

    await repo.upsert({
      placeId: BASE_UPSERT.placeId,
      name: BASE_UPSERT.name,
      orgId: BASE_UPSERT.orgId,
      address: {
        formatted: BASE_UPSERT.address.formatted,
        line1: BASE_UPSERT.address.line1,
        countryCode: BASE_UPSERT.address.countryCode,
      },
    });

    // `status` @default(ACTIVE) and `verification` @default(UNVERIFIED) in
    // place.prisma, and lat/lng are nullable with no default — so omitting
    // them from the create payload is identical to the old explicit nulls.
    const createData = create.mock.calls[0]?.[0]?.data;
    if (createData) {
      expect(createData.status).toBeUndefined();
      expect(createData.verification).toBeUndefined();
    }
  });
});

// ── Address privacy: the OMITTED-preserves contract ─────────────────────────
//
// Same contract as website/phone above, and it matters MORE here: the failure
// mode of an accidental write is a WITHHELD venue being silently un-withheld
// by a caller that only wanted to flip a payout term.
//
// The radius has an extra wrinkle. Elsewhere in this file `null` means
// "clear it"; for `locationRadiusMeters` under OBSCURED, null is the
// documented FULLY-HIDDEN sentinel — the strictest setting, not an absence.
// So the hasOwnProperty guard is what separates "don't touch it" from "hide
// the map entirely", and a `?? null` here would hide every venue any caller
// ever re-saved.
describe("makePlacesRepo.upsert — address privacy preservation", () => {
  it("writes NOTHING for privacy when the caller omits all three keys", async () => {
    const { p, update } = makePrisma();

    await makePlacesRepo(p).upsert({ ...BASE_UPSERT });

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("locationMode");
    expect(data).not.toHaveProperty("locationRadiusMeters");
    expect(data).not.toHaveProperty("locationLabel");
  });

  it("writes an explicit NULL radius — the fully-hidden sentinel is a real value", async () => {
    const { p, update } = makePrisma();

    await makePlacesRepo(p).upsert({
      ...BASE_UPSERT,
      locationMode: "OBSCURED",
      locationRadiusMeters: null,
    });

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.locationMode).toBe("OBSCURED");
    expect(data).toHaveProperty("locationRadiusMeters", null);
  });

  it("writes an explicit circle radius and label", async () => {
    const { p, update } = makePrisma();

    await makePlacesRepo(p).upsert({
      ...BASE_UPSERT,
      locationMode: "OBSCURED",
      locationRadiusMeters: 1200,
      locationLabel: "East Nashville",
    });

    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.locationRadiusMeters).toBe(1200);
    expect(data.locationLabel).toBe("East Nashville");
  });

  it("maps the privacy columns onto the returned record", async () => {
    const { p } = makePrisma();

    const record = await makePlacesRepo(p).upsert({ ...BASE_UPSERT });

    expect(record.locationMode).toBe("OBSCURED");
    expect(record.locationRadiusMeters).toBeNull();
    expect(record.locationLabel).toBe("East Nashville");
  });

  it("FAILS CLOSED mapping a row whose locationMode is not the literal EXACT", async () => {
    // The column is NOT NULL with an EXACT default, so this only fires on a
    // hand-built row — which is precisely the case where a silent
    // `?? "EXACT"` would leak.
    const update = vi.fn(async () => ({ ...UPDATED_ROW, locationMode: null }));
    const p = {
      place: {
        update,
        create: vi.fn(async () => UPDATED_ROW),
        findUnique: vi.fn(async () => UPDATED_ROW),
      },
      placeOwnership: { findMany: vi.fn(async () => []), upsert: vi.fn() },
    } as unknown as PrismaClientOrTx;

    const record = await makePlacesRepo(p).upsert({ ...BASE_UPSERT });

    expect(record.locationMode).toBe("OBSCURED");
  });
});
