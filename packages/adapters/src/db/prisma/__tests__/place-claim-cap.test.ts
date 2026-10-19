import { describe, expect, it, vi } from "vitest";

import { makePlacesRepo } from "../places";
import { makePlaceVerificationRequestsRepo } from "../place-verification-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for the anti-squatting cap (submit-place-claim,
 * FR-004). Mocked Prisma: the point is the WHERE clause and the lock key, so
 * an org claim filed by a person counts against that person.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("placeVerificationRequests.countOpenClaimsByClaimant", () => {
  it("counts open OWNERSHIP_CLAIM rows by the person who filed, any owner kind", async () => {
    const count = vi.fn().mockResolvedValue(7);
    const prisma = {
      placeVerificationRequest: { count },
    } as unknown as PrismaClientOrTx;

    const result =
      await makePlaceVerificationRequestsRepo(prisma).countOpenClaimsByClaimant(
        ACTOR_ID,
      );

    expect(result).toBe(7);
    // No claimOwnerType / claimOwnerId filter: an org claim carries the
    // filer in claimantHumanId just as a human claim does.
    expect(count).toHaveBeenCalledWith({
      where: {
        claimantHumanId: ACTOR_ID,
        source: "OWNERSHIP_CLAIM",
        status: { in: ["PENDING", "IN_REVIEW"] },
      },
    });
  });
});

describe("places.lockClaimsByActor", () => {
  it("takes a transaction-scoped advisory lock on a prefixed actor key", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const prisma = { $executeRaw: executeRaw } as unknown as PrismaClientOrTx;

    await makePlacesRepo(prisma).lockClaimsByActor(ACTOR_ID);

    expect(executeRaw).toHaveBeenCalledOnce();
    const [strings, ...values] = executeRaw.mock.calls[0]!;
    expect((strings as string[]).join("?")).toBe(
      "SELECT pg_advisory_xact_lock(hashtext(?))",
    );
    // Parameterized, and kept apart from lockPlaceForClaim's bare placeId key.
    expect(values).toEqual([`place_claim_actor:${ACTOR_ID}`]);
  });
});
