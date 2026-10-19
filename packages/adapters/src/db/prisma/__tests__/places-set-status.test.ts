import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

// `places.setStatus` (the community-moderator archive / restore): ONE column
// written, so a status change can never rewrite the name, address or hash.

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
  status: "ARCHIVED",
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

describe("makePlacesRepo.setStatus", () => {
  it("writes only `status` and returns the mapped row", async () => {
    const update = vi.fn(async () => UPDATED_ROW);
    const p = {
      place: { update },
      placeOwnership: { findMany: vi.fn(async () => []) },
    } as unknown as PrismaClientOrTx;

    const record = await makePlacesRepo(p).setStatus({
      placeId: PLACE_ID,
      status: "ARCHIVED",
    });

    const call = update.mock.calls[0] as unknown as [
      { where: unknown; data: Record<string, unknown> },
    ];
    expect(call[0].where).toEqual({ id: PLACE_ID });
    expect(call[0].data).toEqual({ status: "ARCHIVED" });
    expect(record).toMatchObject({ id: PLACE_ID, status: "ARCHIVED" });
  });
});

// The staff directory toggles and the verification flip: ONE column each,
// as a compare-and-set, so a flip can never write back a name/address/pin read
// before the transaction, and `changed` reports whether THIS call moved it.
describe("makePlacesRepo.setDirectoryListing", () => {
  it("CAS: writes only `listedInDirectory`, only while the row holds the opposite", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).setDirectoryListing({
      placeId: PLACE_ID,
      listedInDirectory: true,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: PLACE_ID, listedInDirectory: false },
      data: { listedInDirectory: true },
    });
    expect(out).toEqual({ changed: true });
  });

  it("reports changed:false when the row already held the value", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).setDirectoryListing({
      placeId: PLACE_ID,
      listedInDirectory: false,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: PLACE_ID, listedInDirectory: true },
      data: { listedInDirectory: false },
    });
    expect(out).toEqual({ changed: false });
  });
});

describe("makePlacesRepo.setVerificationStatus", () => {
  it("CAS: writes only `verification`, only while the row still holds `from`", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).setVerificationStatus({
      placeId: PLACE_ID,
      from: "UNVERIFIED",
      to: "VERIFIED",
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: PLACE_ID, verification: "UNVERIFIED" },
      data: { verification: "VERIFIED" },
    });
    expect(out).toEqual({ changed: true });
  });

  it("reports changed:false when the status moved since the read", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).setVerificationStatus({
      placeId: PLACE_ID,
      from: "UNVERIFIED",
      to: "VERIFIED",
    });

    expect(out).toEqual({ changed: false });
  });
});

// The owner archive / restore / suspend: `status` ONLY, as a compare-and-set,
// so it can never write back a name/address read before the transaction (or a
// NULL country as "US").
describe("makePlacesRepo.compareAndSetStatus", () => {
  it("CAS: writes only `status`, only while the row still holds `from`", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).compareAndSetStatus({
      placeId: PLACE_ID,
      from: "ACTIVE",
      to: "ARCHIVED",
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: PLACE_ID, status: "ACTIVE" },
      data: { status: "ARCHIVED" },
    });
    expect(out).toEqual({ changed: true });
  });

  it("reports changed:false when the status moved since the read", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const p = { place: { updateMany } } as unknown as PrismaClientOrTx;

    const out = await makePlacesRepo(p).compareAndSetStatus({
      placeId: PLACE_ID,
      from: "ACTIVE",
      to: "SUSPENDED",
    });

    expect(out).toEqual({ changed: false });
  });
});
