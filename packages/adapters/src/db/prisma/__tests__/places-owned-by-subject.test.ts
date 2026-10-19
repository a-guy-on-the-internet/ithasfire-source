import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

/**
 * `listOwnedBySubject` is the OWNER-centric, actor-free place lookup behind the
 * public embed widget's `scope: "venues"` / `"all"`.
 *
 * Its ownership predicate is the security boundary: it must count ONLY
 * `verified = true` AND `revokedAt = null` ownership rows. Without that, a
 * provisional (unreviewed) or soft-revoked claim against a rival venue would
 * let the claimant pull that venue's public calendar onto their own website.
 *
 * Unlike `places-access-gating.test.ts` — where the predicate is applied in JS
 * and can be tested by feeding unfiltered rows — this predicate lives in the
 * SQL `where`, so the assertion is on the query Prisma is asked to run.
 */

const PLACE_ID = "place-1";
const ORG_ID = "org-1";
const HUMAN_ID = "human-1";

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
  website: null,
  websiteSource: "USER_STUB",
  status: "ACTIVE",
  verification: "UNVERIFIED",
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  listedInDirectory: false,
  acceptsBookingRequests: false,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  ownerships: [
    {
      ownerId: ORG_ID,
      ownerType: "ORGANIZATION" as const,
      verified: true,
      revokedAt: null,
    },
  ],
};

function makePrisma(rows: unknown[] = [PLACE_ROW]) {
  const findMany = vi.fn(async () => rows);
  const prisma = {
    place: { findMany },
    placeOwnership: { findMany: vi.fn(async () => []) },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

describe("makePlacesRepo.listOwnedBySubject — ownership predicate", () => {
  it("requires VERIFIED + non-revoked ownership for the given subject", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({ ownerType: "ORGANIZATION", ownerId: ORG_ID });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.ownerships.some).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      verified: true,
      revokedAt: null,
    });
  });

  it("keys the predicate on HUMAN ownership for human subjects", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({ ownerType: "HUMAN", ownerId: HUMAN_ID });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.ownerships.some).toEqual({
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
      verified: true,
      revokedAt: null,
    });
  });

  it("constrains results to ACTIVE places", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({ ownerType: "ORGANIZATION", ownerId: ORG_ID });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.status).toBe("ACTIVE");
  });

  it("never widens the predicate to unverified or revoked rows", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({ ownerType: "ORGANIZATION", ownerId: ORG_ID });

    // Guard against a future refactor loosening the gate: the serialized query
    // must not contain an OR / NOT escape hatch around the ownership clause.
    const args = findMany.mock.calls[0]![0] as any;
    expect(args.where.ownerships.some.verified).toBe(true);
    expect(args.where.ownerships.some.revokedAt).toBeNull();
    expect(args.where.OR).toBeUndefined();
    expect(args.where.NOT).toBeUndefined();
  });

  it("clamps the limit to a sane maximum so one subject can't fan out unbounded", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 10_000,
    });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.take).toBe(100);
  });

  it("applies a default limit when none is given", async () => {
    const { prisma, findMany } = makePrisma();
    const repo = makePlacesRepo(prisma);

    await repo.listOwnedBySubject({ ownerType: "ORGANIZATION", ownerId: ORG_ID });

    const args = findMany.mock.calls[0]![0] as any;
    expect(args.take).toBe(25);
  });

  it("maps rows to PlaceRecord DTOs (never raw Prisma models)", async () => {
    const { prisma } = makePrisma();
    const repo = makePlacesRepo(prisma);

    const places = await repo.listOwnedBySubject({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
    });

    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      id: PLACE_ID,
      name: "The Fillmore",
      orgIdsWithAccess: [ORG_ID],
      humanIdsWithAccess: [],
    });
    // `ownerships` is a Prisma relation, not part of the DTO.
    expect(places[0]).not.toHaveProperty("ownerships");
  });

  it("returns an empty list when the subject owns nothing", async () => {
    const { prisma } = makePrisma([]);
    const repo = makePlacesRepo(prisma);

    const places = await repo.listOwnedBySubject({
      ownerType: "HUMAN",
      ownerId: HUMAN_ID,
    });
    expect(places).toEqual([]);
  });
});
