import { describe, expect, it, vi } from "vitest";

import { makeBookingRequestsRepo } from "../booking-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for `countOpenByPlace` (booking-inbox-placement
 * FR-006), the grouped counting twin of `listForPlace`.
 *
 * The contract is not just "returns numbers": FR-006 requires the endpoint to
 * be COUNT-shaped (never findMany-and-map, which is what the old capped hub
 * fan-out did), and the WHERE must see exactly the row set the venue inbox
 * lists — same `direction: "TO_VENUE"` scope, same open-status set. Those live
 * in the SQL, so the assertion is on the query Prisma is asked to run.
 *
 * Sibling coverage for the other two count twins lives in
 * `work-summary-counts.test.ts`.
 */

const PLACE_A = "33333333-3333-4333-8333-333333333333";
const PLACE_B = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";

function bookingPrisma(groups: unknown[] = []) {
  const groupBy = vi.fn(async () => groups);
  const findMany = vi.fn(async () => []);
  const count = vi.fn(async () => 0);
  const prisma = {
    bookingRequest: { groupBy, findMany, count },
  } as unknown as PrismaClientOrTx;
  return { prisma, groupBy, findMany, count };
}

describe("bookingRequests.countOpenByPlace", () => {
  it("groups by placeId with the TO_VENUE + open-status scope (never a list map)", async () => {
    const { prisma, groupBy, findMany } = bookingPrisma([
      { placeId: PLACE_A, _count: { _all: 3 } },
    ]);

    const result = await makeBookingRequestsRepo(prisma).countOpenByPlace({
      placeIds: [PLACE_A, PLACE_B],
      statuses: ["PENDING", "VIEWED"],
    });

    expect(result).toEqual([{ placeId: PLACE_A, openCount: 3 }]);
    expect(groupBy).toHaveBeenCalledWith({
      by: ["placeId"],
      where: {
        // Load-bearing (NFR-001): same direction scope as `listForPlace`, so
        // the badge and the inbox can never disagree.
        direction: "TO_VENUE",
        placeId: { in: [PLACE_A, PLACE_B] },
        status: { in: ["PENDING", "VIEWED"] },
      },
      _count: { _all: true },
    });
    // FR-006: the counts must not be derived from full rows.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("defaults to the shared open-status set when statuses are omitted", async () => {
    const { prisma, groupBy } = bookingPrisma();

    await makeBookingRequestsRepo(prisma).countOpenByPlace({
      placeIds: [PLACE_A],
    });

    const args = groupBy.mock.calls[0]![0] as {
      where: { status: { in: string[] } };
    };
    expect(args.where.status.in).toEqual(["PENDING", "VIEWED"]);
    // Terminal statuses can never be folded into an "open" count.
    for (const terminal of ["EXPIRED", "DECLINED", "WITHDRAWN", "ACCEPTED"]) {
      expect(args.where.status.in).not.toContain(terminal);
    }
  });

  it("emits nothing for places with no matching rows (callers zero-fill)", async () => {
    const { prisma } = bookingPrisma([
      { placeId: PLACE_B, _count: { _all: 1 } },
    ]);

    const result = await makeBookingRequestsRepo(prisma).countOpenByPlace({
      placeIds: [PLACE_A, PLACE_B],
    });

    expect(result).toEqual([{ placeId: PLACE_B, openCount: 1 }]);
  });

  it("drops a null placeId group defensively", async () => {
    // TO_VENUE rows always carry a placeId (CHECK constraint), but `groupBy`
    // types the key nullable — a null group must never become `{ placeId:
    // null }` in the response.
    const { prisma } = bookingPrisma([
      { placeId: null, _count: { _all: 7 } },
      { placeId: PLACE_A, _count: { _all: 2 } },
    ]);

    const result = await makeBookingRequestsRepo(prisma).countOpenByPlace({
      placeIds: [PLACE_A],
    });

    expect(result).toEqual([{ placeId: PLACE_A, openCount: 2 }]);
  });

  it("short-circuits an empty placeIds set without querying", async () => {
    const { prisma, groupBy } = bookingPrisma();

    await expect(
      makeBookingRequestsRepo(prisma).countOpenByPlace({ placeIds: [] }),
    ).resolves.toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
