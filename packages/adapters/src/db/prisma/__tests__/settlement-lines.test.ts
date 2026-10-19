import { describe, expect, it, vi } from "vitest";

import { makeSettlementLinesRepo } from "../settlement-lines";
import type { PrismaClientOrTx } from "../types";

describe("makeSettlementLinesRepo", () => {
  it("finds settlement ids whose orders have blocked dispute statuses", async () => {
    const findMany = vi.fn(async () => [
      { settlementId: "settlement-1" },
      { settlementId: "settlement-1" },
      { settlementId: "settlement-3" },
    ]);
    const prisma = {
      settlementLine: { findMany },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    const result = await repo.settlementIdsWithDisputedOrders(
      ["settlement-1", "settlement-2", "settlement-3"],
      ["OPEN", "UNDER_REVIEW", "LOST"],
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        settlementId: {
          in: ["settlement-1", "settlement-2", "settlement-3"],
        },
        order: { disputeStatus: { in: ["OPEN", "UNDER_REVIEW", "LOST"] } },
      },
      select: { settlementId: true },
      distinct: ["settlementId"],
    });
    expect(result).toEqual(new Set(["settlement-1", "settlement-3"]));
  });

  it("finds settlement ids whose orders match the given kinds", async () => {
    const findMany = vi.fn(async () => [
      { settlementId: "settlement-2" },
      { settlementId: "settlement-2" },
    ]);
    const prisma = {
      settlementLine: { findMany },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    const result = await repo.settlementIdsWithOrderKinds(
      ["settlement-1", "settlement-2"],
      ["MEMBERSHIP"],
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        settlementId: { in: ["settlement-1", "settlement-2"] },
        order: { kind: { in: ["MEMBERSHIP"] } },
      },
      select: { settlementId: true },
      distinct: ["settlementId"],
    });
    expect(result).toEqual(new Set(["settlement-2"]));
  });

  it("short-circuits the order-kind lookup on empty inputs", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      settlementLine: { findMany },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    expect(await repo.settlementIdsWithOrderKinds([], ["TICKETING"])).toEqual(
      new Set(),
    );
    expect(await repo.settlementIdsWithOrderKinds(["s-1"], [])).toEqual(
      new Set(),
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it("sums line amounts per settlement for the given order kinds", async () => {
    const groupBy = vi.fn(async () => [
      { settlementId: "settlement-1", _sum: { amountCents: 4_500 } },
      { settlementId: "settlement-3", _sum: { amountCents: null } },
    ]);
    const prisma = {
      settlementLine: { groupBy },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    const result = await repo.sumSettlementAmountsForOrderKinds(
      ["settlement-1", "settlement-2", "settlement-3"],
      ["MEMBERSHIP"],
    );

    // One grouped query, same relation path as the id-based guards; the
    // per-settlement sum is done in the database.
    expect(groupBy).toHaveBeenCalledWith({
      by: ["settlementId"],
      where: {
        settlementId: { in: ["settlement-1", "settlement-2", "settlement-3"] },
        order: { kind: { in: ["MEMBERSHIP"] } },
      },
      _sum: { amountCents: true },
    });
    expect(result.get("settlement-1")).toBe(4_500);
    expect(result.get("settlement-3")).toBe(0);
    // No matching lines → absent, not zero-filled.
    expect(result.has("settlement-2")).toBe(false);
  });

  it("short-circuits the amount-sum lookup on empty inputs", async () => {
    const groupBy = vi.fn(async () => []);
    const prisma = {
      settlementLine: { groupBy },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    expect(
      await repo.sumSettlementAmountsForOrderKinds([], ["MEMBERSHIP"]),
    ).toEqual(new Map());
    expect(await repo.sumSettlementAmountsForOrderKinds(["s-1"], [])).toEqual(
      new Map(),
    );
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("finds settlement ids for an order by settlement statuses", async () => {
    const findMany = vi.fn(async () => [
      { settlementId: "settlement-2" },
      { settlementId: "settlement-4" },
    ]);
    const prisma = {
      settlementLine: { findMany },
    } as unknown as PrismaClientOrTx;
    const repo = makeSettlementLinesRepo(prisma);

    const result = await repo.settlementIdsForOrderWithSettlementStatuses(
      "order-1",
      ["transferring"],
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        orderId: "order-1",
        settlement: { status: { in: ["transferring"] } },
      },
      select: { settlementId: true },
      distinct: ["settlementId"],
    });
    expect(result).toEqual(new Set(["settlement-2", "settlement-4"]));
  });
});