import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

const PLACE_ID = "place-1";

const PLACE_ROW = {
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
  addressHash: null,
  admissionTaxRateBps: null,
  taxRateSource: null,
  taxRateFetchedAt: null,
  capacity: 1200,
  lat: null,
  lng: null,
  phone: null,
  website: "https://thefillmore.com",
  websiteSource: "USER_STUB",
  status: "ACTIVE",
  verification: "UNVERIFIED",
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  listedInDirectory: false,
  acceptsBookingRequests: false,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

/**
 * Fake prisma that returns ALL ownership rows regardless of the `where` filter,
 * so the adapter's JS-side access predicate (verified === true &&
 * revokedAt === null) is the thing under test — a provisional or revoked row
 * must never leak into orgIdsWithAccess / humanIdsWithAccess (FR-005).
 */
function makePrisma(
  ownerships: Array<{
    ownerId: string;
    ownerType: "HUMAN" | "ORGANIZATION";
    verified: boolean;
    revokedAt: Date | null;
  }>,
): PrismaClientOrTx {
  return {
    place: {
      findUnique: vi.fn(async () => PLACE_ROW),
    },
    placeOwnership: {
      findMany: vi.fn(async () => ownerships),
    },
  } as unknown as PrismaClientOrTx;
}

describe("makePlacesRepo — access gating (FR-005)", () => {
  it("a VERIFIED, non-revoked owner grants access", async () => {
    const repo = makePlacesRepo(
      makePrisma([
        { ownerId: "org-1", ownerType: "ORGANIZATION", verified: true, revokedAt: null },
      ]),
    );
    const place = await repo.getById(PLACE_ID);
    expect(place?.orgIdsWithAccess).toEqual(["org-1"]);
    expect(place?.humanIdsWithAccess).toEqual([]);
  });

  it("a PROVISIONAL (verified=false) claim does NOT grant access", async () => {
    const repo = makePlacesRepo(
      makePrisma([
        { ownerId: "human-1", ownerType: "HUMAN", verified: false, revokedAt: null },
      ]),
    );
    const place = await repo.getById(PLACE_ID);
    expect(place?.humanIdsWithAccess).toEqual([]);
    expect(place?.orgIdsWithAccess).toEqual([]);
  });

  it("a soft-revoked (revokedAt set) owner does NOT grant access", async () => {
    const repo = makePlacesRepo(
      makePrisma([
        {
          ownerId: "human-1",
          ownerType: "HUMAN",
          verified: false,
          revokedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ]),
    );
    const place = await repo.getById(PLACE_ID);
    expect(place?.humanIdsWithAccess).toEqual([]);
  });

  it("co-ownership: a place CAN hold BOTH an org and a human verified owner", async () => {
    // Guards against re-introducing a "one verified owner per place" constraint
    // (the dev seed's place8 is co-owned by human6 + org4).
    const repo = makePlacesRepo(
      makePrisma([
        { ownerId: "org-4", ownerType: "ORGANIZATION", verified: true, revokedAt: null },
        { ownerId: "human-6", ownerType: "HUMAN", verified: true, revokedAt: null },
      ]),
    );
    const place = await repo.getById(PLACE_ID);
    expect(place?.orgIdsWithAccess).toEqual(["org-4"]);
    expect(place?.humanIdsWithAccess).toEqual(["human-6"]);
  });

  it("mixes: only the verified/non-revoked rows survive", async () => {
    const repo = makePlacesRepo(
      makePrisma([
        { ownerId: "org-verified", ownerType: "ORGANIZATION", verified: true, revokedAt: null },
        { ownerId: "human-provisional", ownerType: "HUMAN", verified: false, revokedAt: null },
        {
          ownerId: "human-revoked",
          ownerType: "HUMAN",
          verified: true,
          revokedAt: new Date("2026-07-02T00:00:00.000Z"),
        },
      ]),
    );
    const place = await repo.getById(PLACE_ID);
    expect(place?.orgIdsWithAccess).toEqual(["org-verified"]);
    expect(place?.humanIdsWithAccess).toEqual([]);
  });
});
