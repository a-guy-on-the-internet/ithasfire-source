import { describe, expect, it, vi } from "vitest";

import { makeBookingRequestsRepo } from "../booking-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for `listForPlaces` — the set-shaped twin of
 * `listForPlace` behind the org-wide venue inbox
 * (`listBookingRequests({ scope: "org-venues" })`).
 *
 * Two properties live entirely in the SQL, so the assertion is on the query
 * Prisma is asked to run:
 *   - NFR-001: the same `direction: "TO_VENUE"` scope as `listForPlace`, so a
 *     TO_PERFORMER row can never surface in a venue inbox;
 *   - ONE `IN (...)` query for the whole place set, never a loop — the caller's
 *     set is capped at 100 venues, and a hundred sequential round trips per
 *     inbox load is the fan-out `countOpenByPlace` was introduced to delete.
 *
 * Sibling coverage for the grouped count twin lives in
 * `booking-requests-open-counts.test.ts`.
 */

const PLACE_A = "33333333-3333-4333-8333-333333333333";
const PLACE_B = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";

function bookingPrisma(rows: unknown[] = []) {
  const findMany = vi.fn(async () => rows);
  const groupBy = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = {
    bookingRequest: { findMany, groupBy, count },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany, groupBy, count };
}

/** Minimal row shape `toToVenueRecord` needs (relations + the CHECK-y columns). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    direction: "TO_VENUE",
    placeId: PLACE_A,
    organizerOrgId: null,
    attachedEventId: null,
    calendarId: null,
    performerOwnerType: "human",
    performerOwnerId: "11111111-1111-4111-8111-111111111111",
    contactName: null,
    contactEmail: null,
    source: "PLATFORM",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    message: "hello",
    preferredDates: ["2026-07-10"],
    expectedDraw: null,
    genre: null,
    links: [],
    tags: [],
    assigneeHumanId: null,
    taxFormStatus: "NONE",
    lastMessageAt: null,
    actName: null,
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    verifiedStatsSnapshot: null,
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    place: { name: "The Ember Room" },
    organizerOrg: null,
    attachedEvent: null,
    ...overrides,
  };
}

describe("bookingRequests.listForPlaces", () => {
  it("fetches the whole place set in ONE query with the TO_VENUE scope", async () => {
    const { prisma, findMany } = bookingPrisma([row()]);

    const result = await makeBookingRequestsRepo(prisma).listForPlaces({
      placeIds: [PLACE_A, PLACE_B],
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(args.where).toEqual({
      placeId: { in: [PLACE_A, PLACE_B] },
      // Load-bearing (NFR-001): identical to `listForPlace`, so the org inbox
      // and the per-venue inbox can never show different rows for one venue.
      direction: "TO_VENUE",
    });
    // Deterministic across loads — rows from several venues interleave, so
    // `createdAt` alone leaves ties to the DB's discretion.
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);

    // The venue name rides the row (denormalized join) — the org inbox groups
    // by venue off THIS response, with no companion place query.
    expect(result[0]).toMatchObject({
      placeId: PLACE_A,
      placeName: "The Ember Room",
      direction: "TO_VENUE",
    });
  });

  it("applies a status filter, and omits the clause entirely when none is given", async () => {
    const { prisma, findMany } = bookingPrisma();
    const repo = makeBookingRequestsRepo(prisma);

    await repo.listForPlaces({
      placeIds: [PLACE_A],
      statuses: ["DECLINED", "EXPIRED"],
    });
    expect(
      (findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where,
    ).toMatchObject({ status: { in: ["DECLINED", "EXPIRED"] } });

    // An unfiltered org inbox must see EVERY status — the thread stays live
    // after a decline, so terminal rows are part of the surface.
    await repo.listForPlaces({ placeIds: [PLACE_A], statuses: [] });
    expect(
      (findMany.mock.calls[1]![0] as { where: Record<string, unknown> }).where,
    ).not.toHaveProperty("status");
  });

  it("short-circuits an empty placeIds set without querying", async () => {
    // An act-only org owns no venues; that must cost zero round trips.
    const { prisma, findMany } = bookingPrisma();

    await expect(
      makeBookingRequestsRepo(prisma).listForPlaces({ placeIds: [] }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
