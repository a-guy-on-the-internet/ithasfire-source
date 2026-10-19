import { describe, expect, it, vi } from "vitest";

import { makeClaimsRepo } from "../claims";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// Claim status and seller-reply writes are CONDITIONAL (port doc): a write
// that would land on a claim another transition already moved on matches no
// row and returns null instead of overwriting the decision. Mock-Prisma test
// for the WHERE shape; the row-level re-check under a concurrent update is
// Postgres' job.
// ---------------------------------------------------------------------------

const ROW = {
  id: "claim-1",
  orderId: "order-1",
  orderItemId: "item-1",
  eventId: "event-1",
  claimantId: "buyer-1",
  respondentId: "seller-1",
  kind: "ticket_invalid",
  status: "approved",
  evidence: {},
  deadline: new Date("2026-03-15T12:00:00Z"),
  resolvedAt: new Date("2026-03-11T12:00:00Z"),
  resolvedById: "staff-1",
  resolutionNote: null,
  resolution: "full_refund",
  sellerEvidence: {},
  sellerRespondedAt: null,
  createdAt: new Date("2026-03-10T12:00:00Z"),
  updatedAt: new Date("2026-03-11T12:00:00Z"),
};

function makePrisma(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const findUnique = vi.fn(async () => ROW);
  const update = vi.fn();
  const prisma = {
    claim: { updateMany, findUnique, update },
  } as unknown as PrismaClientOrTx;
  return { prisma, updateMany, findUnique, update };
}

describe("makeClaimsRepo.updateStatus", () => {
  it("writes only while the row still has the expected prior status", async () => {
    const { prisma, updateMany, findUnique, update } = makePrisma(1);
    const repo = makeClaimsRepo(prisma);

    const result = await repo.updateStatus("claim-1", {
      fromStatus: "open",
      status: "approved",
      resolution: "full_refund",
      resolvedById: "staff-1",
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "claim-1", status: "open" },
      data: expect.objectContaining({
        status: "approved",
        resolution: "full_refund",
        resolvedById: "staff-1",
        resolvedAt: expect.any(Date),
      }),
    });
    // The prior status is a guard, never a column written.
    const data = (updateMany.mock.calls[0] as unknown as [{ data: object }])[0]
      .data;
    expect(data).not.toHaveProperty("fromStatus");
    expect(update).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "claim-1" } });
    expect(result?.id).toBe("claim-1");
  });

  it("returns null and reads nothing back when the status moved on (0 rows)", async () => {
    const { prisma, findUnique } = makePrisma(0);
    const repo = makeClaimsRepo(prisma);

    const result = await repo.updateStatus("claim-1", {
      fromStatus: "open",
      status: "under_review",
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("makeClaimsRepo.recordSellerResponse", () => {
  it("writes only while the claim is undecided", async () => {
    const { prisma, updateMany } = makePrisma(1);
    const repo = makeClaimsRepo(prisma);
    const respondedAt = new Date("2026-03-12T08:00:00Z");

    await repo.recordSellerResponse("claim-1", {
      sellerEvidence: { reply: "It scanned" },
      respondedAt,
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "claim-1", status: { in: ["open", "under_review"] } },
      data: {
        sellerEvidence: { reply: "It scanned" },
        sellerRespondedAt: respondedAt,
      },
    });
  });

  it("returns null when the claim was already decided (0 rows)", async () => {
    const { prisma, findUnique } = makePrisma(0);
    const repo = makeClaimsRepo(prisma);

    const result = await repo.recordSellerResponse("claim-1", {
      sellerEvidence: { reply: "late" },
      respondedAt: new Date(),
    });

    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("makeClaimsRepo.refundedOrderIds", () => {
  it("reads REFUNDED orders among the ids in ONE query", async () => {
    const findMany = vi.fn(async () => [{ id: "order-1" }]);
    const prisma = { order: { findMany } } as unknown as PrismaClientOrTx;
    const repo = makeClaimsRepo(prisma);

    const result = await repo.refundedOrderIds(["order-1", "order-2"]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ["order-1", "order-2"] }, status: "REFUNDED" },
      select: { id: true },
    });
    expect([...result]).toEqual(["order-1"]);
  });

  it("makes no query for an empty id list", async () => {
    const findMany = vi.fn();
    const prisma = { order: { findMany } } as unknown as PrismaClientOrTx;

    const result = await makeClaimsRepo(prisma).refundedOrderIds([]);

    expect(result.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("makeClaimsRepo.listByClaimant", () => {
  function makeListPrisma() {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const prisma = { claim: { findMany, count } } as unknown as PrismaClientOrTx;
    return { prisma, findMany, count };
  }

  it("narrows to one order when orderId is given (list AND count)", async () => {
    const { prisma, findMany, count } = makeListPrisma();

    await makeClaimsRepo(prisma).listByClaimant("buyer-1", { orderId: "order-1" });

    const where = { claimantId: "buyer-1", orderId: "order-1" };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where }));
    expect(count).toHaveBeenCalledWith({ where });
  });

  it("lists every claim of the buyer without orderId", async () => {
    const { prisma, findMany } = makeListPrisma();

    await makeClaimsRepo(prisma).listByClaimant("buyer-1", {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { claimantId: "buyer-1" } }),
    );
  });
});
