import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import type { PrismaClientOrTx } from "../types";

/**
 * `bulkCreate` used to write a VERIFIED `PlaceOwnership` row for EVERY place in
 * the batch, because `owner` was a required field on `BulkCreatePlaceInput`.
 * The platform CSV importer satisfied that by naming the importing staff human,
 * so several hundred scraped venues would each land owned-and-verified by a
 * staff account. `getPlaceClaimEligibility` reads
 * `getVerifiedOwnershipForPlace` and returns `already_claimed` /
 * `verified_owner_exists` the instant one exists — so the venue's real operator
 * could never claim it and got the dispute path instead.
 *
 * `owner` is now optional, and ownership rows are written ONLY for the subset
 * of places that carry one. A scraped venue imports UNOWNED and stays
 * `claimable`.
 */

const ADDRESS = {
  formatted: "1805 Geary Blvd, San Francisco, CA 94115, US",
  line1: "1805 Geary Blvd",
  line2: null,
  city: "San Francisco",
  region: "CA",
  postalCode: "94115",
  countryCode: "US",
};

const ORG_ID = "org-1";
const HUMAN_ID = "human-1";

function makePrisma(createdCount: number) {
  const placeCreateMany = vi.fn(async () => ({ count: createdCount }));
  const ownershipCreateMany = vi.fn(async () => ({ count: 0 }));
  const p = {
    place: { createMany: placeCreateMany },
    placeOwnership: { createMany: ownershipCreateMany },
  } as unknown as PrismaClientOrTx;
  return { p, placeCreateMany, ownershipCreateMany };
}

function place(id: string, owner?: { kind: "org"; orgId: string }) {
  return {
    id,
    name: `Venue ${id}`,
    address: ADDRESS,
    ...(owner ? { owner } : {}),
  };
}

describe("makePlacesRepo.bulkCreate — ownership is written only for owned places", () => {
  it("does NOT call placeOwnership.createMany when no place in the batch has an owner", async () => {
    const { p, placeCreateMany, ownershipCreateMany } = makePrisma(2);
    const repo = makePlacesRepo(p);

    const result = await repo.bulkCreate([place("p1"), place("p2")]);

    expect(result).toEqual({ created: 2 });
    expect(placeCreateMany).toHaveBeenCalledTimes(1);
    // The whole point: an unowned import leaves the venue claimable.
    expect(ownershipCreateMany).not.toHaveBeenCalled();
  });

  it("calls placeOwnership.createMany with ONLY the owned subset for a mixed batch", async () => {
    const { p, ownershipCreateMany } = makePrisma(3);
    const repo = makePlacesRepo(p);

    await repo.bulkCreate([
      place("p1", { kind: "org", orgId: ORG_ID }),
      place("p2"),
      {
        id: "p3",
        name: "Venue p3",
        address: ADDRESS,
        owner: { kind: "human" as const, humanId: HUMAN_ID },
      },
    ]);

    expect(ownershipCreateMany).toHaveBeenCalledTimes(1);
    expect(ownershipCreateMany.mock.calls[0]![0]).toEqual({
      data: [
        {
          placeId: "p1",
          ownerType: "ORGANIZATION",
          ownerId: ORG_ID,
          verified: true,
        },
        {
          placeId: "p3",
          ownerType: "HUMAN",
          ownerId: HUMAN_ID,
          verified: true,
        },
      ],
    });
  });

  it("treats an explicit owner: null the same as an absent owner", async () => {
    const { p, ownershipCreateMany } = makePrisma(1);
    const repo = makePlacesRepo(p);

    await repo.bulkCreate([
      { id: "p1", name: "Venue p1", address: ADDRESS, owner: null },
    ]);

    expect(ownershipCreateMany).not.toHaveBeenCalled();
  });

  it("still throws place_insert_count_mismatch — and never writes ownership — when the insert count is short", async () => {
    const { p, ownershipCreateMany } = makePrisma(1);
    const repo = makePlacesRepo(p);

    await expect(
      repo.bulkCreate([
        place("p1", { kind: "org", orgId: ORG_ID }),
        place("p2", { kind: "org", orgId: ORG_ID }),
      ]),
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "place_insert_count_mismatch",
    });
    expect(ownershipCreateMany).not.toHaveBeenCalled();
  });

  // ── websiteSource provenance (FR-010 fast-track) ────────────────────────
  //
  // `TRUSTED_IMPORT` arms the claim fast-track: `submit-place-claim`
  // auto-verifies an email_domain_match against the place's website domain with
  // NO admin review. This default used to be `TRUSTED_IMPORT`, which was inert
  // only because every bulk-imported place also got a verified owner (so the
  // claim was blocked before it could reach the fast-track). Making imports
  // unowned would have armed it across a whole scraped corpus — any holder of a
  // mailbox at a scraped municipal/parent-company domain could self-verify.
  // The default is now fail-safe and trust is an explicit caller opt-in.
  it("defaults websiteSource to UNKNOWN — a scraped import must NOT arm the claim fast-track", async () => {
    const { p, placeCreateMany } = makePrisma(1);
    const repo = makePlacesRepo(p);

    await repo.bulkCreate([place("p1")]);

    const { data } = placeCreateMany.mock.calls[0]![0] as {
      data: { websiteSource: string }[];
    };
    expect(data[0]!.websiteSource).toBe("UNKNOWN");
    expect(data[0]!.websiteSource).not.toBe("TRUSTED_IMPORT");
  });

  it("writes TRUSTED_IMPORT only when the caller passes it explicitly (curated feed opt-in)", async () => {
    const { p, placeCreateMany } = makePrisma(2);
    const repo = makePlacesRepo(p);

    await repo.bulkCreate([
      { ...place("p1"), websiteSource: "TRUSTED_IMPORT" as const },
      { ...place("p2"), websiteSource: "USER_STUB" as const },
    ]);

    const { data } = placeCreateMany.mock.calls[0]![0] as {
      data: { websiteSource: string }[];
    };
    expect(data[0]!.websiteSource).toBe("TRUSTED_IMPORT");
    expect(data[1]!.websiteSource).toBe("USER_STUB");
  });
});
