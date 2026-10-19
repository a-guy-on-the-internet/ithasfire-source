import { describe, expect, it, vi } from "vitest";

import { makeBookingRequestsRepo } from "../booking-requests";
import { makePlaceVerificationRequestsRepo } from "../place-verification-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for the count methods that feed
 * `humans.getMyWorkSummary`. These assert the WHERE clauses directly (mocked
 * Prisma) — the point is that each count sees exactly the same row set as the
 * list method it mirrors, so "count > 0" can never disagree with "the list
 * renders rows".
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function bookingPrisma() {
  const count = vi.fn();
  count.mockResolvedValue(0);
  const prisma = {
    bookingRequest: { count },
  } as unknown as PrismaClientOrTx;
  return { prisma, count };
}

function claimsPrisma() {
  const count = vi.fn();
  count.mockResolvedValue(0);
  const prisma = {
    placeVerificationRequest: { count },
  } as unknown as PrismaClientOrTx;
  return { prisma, count };
}

describe("bookingRequests count twins", () => {
  it("countForPerformer scopes to TO_VENUE and ORs the owner set", async () => {
    const { prisma, count } = bookingPrisma();
    count.mockResolvedValue(4);

    const result = await makeBookingRequestsRepo(prisma).countForPerformer({
      owners: [
        { ownerType: "human", ownerId: ACTOR_ID },
        { ownerType: "organization", ownerId: ORG_ID },
      ],
    });

    expect(result).toBe(4);
    expect(count).toHaveBeenCalledWith({
      where: {
        // Load-bearing (NFR-001): the act pair also identifies the TARGET on
        // TO_PERFORMER rows, so without this a received request would be
        // counted as sent.
        direction: "TO_VENUE",
        OR: [
          { performerOwnerType: "human", performerOwnerId: ACTOR_ID },
          { performerOwnerType: "organization", performerOwnerId: ORG_ID },
        ],
      },
    });
  });

  it("countForPerformerInbox scopes to TO_PERFORMER and applies statuses", async () => {
    const { prisma, count } = bookingPrisma();
    count.mockResolvedValue(2);

    const result = await makeBookingRequestsRepo(prisma).countForPerformerInbox(
      {
        owners: [{ ownerType: "human", ownerId: ACTOR_ID }],
        statuses: ["PENDING", "VIEWED"],
      },
    );

    expect(result).toBe(2);
    expect(count).toHaveBeenCalledWith({
      where: {
        direction: "TO_PERFORMER",
        OR: [{ performerOwnerType: "human", performerOwnerId: ACTOR_ID }],
        status: { in: ["PENDING", "VIEWED"] },
      },
    });
  });

  it("omits the status filter when statuses is empty or absent", async () => {
    const { prisma, count } = bookingPrisma();

    await makeBookingRequestsRepo(prisma).countForPerformerInbox({
      owners: [{ ownerType: "human", ownerId: ACTOR_ID }],
      statuses: [],
    });

    expect(count.mock.calls[0]![0]).not.toHaveProperty("where.status");
  });

  it("short-circuits an empty owner set without querying", async () => {
    const { prisma, count } = bookingPrisma();
    const repo = makeBookingRequestsRepo(prisma);

    await expect(repo.countForPerformer({ owners: [] })).resolves.toBe(0);
    await expect(repo.countForPerformerInbox({ owners: [] })).resolves.toBe(0);
    expect(count).not.toHaveBeenCalled();
  });
});

describe("placeVerificationRequests.countByClaimant", () => {
  it("counts only the claimant's claim + dispute rows (never ORG_SUBMISSION)", async () => {
    const { prisma, count } = claimsPrisma();
    count.mockResolvedValue(3);

    const result =
      await makePlaceVerificationRequestsRepo(prisma).countByClaimant(ACTOR_ID);

    expect(result).toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: {
        claimantHumanId: ACTOR_ID,
        source: { in: ["OWNERSHIP_CLAIM", "OWNERSHIP_DISPUTE"] },
      },
    });
  });
});
