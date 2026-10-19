import { describe, expect, it, vi } from "vitest";

import { makeOrdersRepo } from "../orders";
import type { PrismaClientOrTx } from "../types";

const ORDER_ID = "7d0f4c1e-2222-4222-8222-7d0f4c1e2222";

function createPrisma(rows: unknown[] = []) {
  const createMany = vi.fn(async () => ({ count: 0 }));
  const findMany = vi.fn(async () => rows);
  const prisma = {
    orderTaxLine: { createMany, findMany },
  } as unknown as PrismaClientOrTx;
  return { prisma, createMany, findMany };
}

describe("makeOrdersRepo.createTaxLines", () => {
  it("writes one row per line, all under the order, in a single createMany", async () => {
    const { prisma, createMany } = createPrisma();
    await makeOrdersRepo(prisma).createTaxLines({
      orderId: ORDER_ID,
      lines: [
        {
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: 975,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 2665,
          amountCents: 260,
        },
        {
          code: "VENUE_SEAT",
          label: "Venue seat tax",
          jurisdiction: "US/CO/Denver",
          rateBps: 1000,
          base: "TICKET_FACE",
          collector: "ORGANISER",
          taxableAmountCents: 2500,
          amountCents: 250,
        },
      ],
    });

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          orderId: ORDER_ID,
          code: "SALES",
          label: "Sales tax",
          jurisdiction: "US/TN",
          rateBps: 975,
          base: "BUYER_TOTAL",
          collector: "PLATFORM",
          taxableAmountCents: 2665,
          amountCents: 260,
        },
        {
          orderId: ORDER_ID,
          code: "VENUE_SEAT",
          label: "Venue seat tax",
          jurisdiction: "US/CO/Denver",
          rateBps: 1000,
          base: "TICKET_FACE",
          collector: "ORGANISER",
          taxableAmountCents: 2500,
          amountCents: 250,
        },
      ],
    });
  });

  it("an empty list issues no query", async () => {
    const { prisma, createMany } = createPrisma();
    await makeOrdersRepo(prisma).createTaxLines({ orderId: ORDER_ID, lines: [] });
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("makeOrdersRepo.listTaxLines", () => {
  it("scopes to the order and maps rows to DTOs (no extra Prisma fields leak)", async () => {
    const createdAt = new Date("2026-09-28T12:00:00.000Z");
    const { prisma, findMany } = createPrisma([
      {
        id: "line-1",
        orderId: ORDER_ID,
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/GA",
        rateBps: 890,
        base: "TICKET_FACE",
        collector: "PLATFORM",
        taxableAmountCents: 2500,
        amountCents: 223,
        createdAt,
        somePrismaOnlyField: "must not leak",
      },
    ]);

    const lines = await makeOrdersRepo(prisma).listTaxLines(ORDER_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: ORDER_ID },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(lines).toEqual([
      {
        id: "line-1",
        orderId: ORDER_ID,
        code: "SALES",
        label: "Sales tax",
        jurisdiction: "US/GA",
        rateBps: 890,
        base: "TICKET_FACE",
        collector: "PLATFORM",
        taxableAmountCents: 2500,
        amountCents: 223,
        createdAt,
      },
    ]);
  });
});

describe("makeOrdersRepo.listTaxLinesByOrderIds", () => {
  const OTHER_ORDER_ID = "8e1f5d2f-3333-4333-8333-8e1f5d2f3333";
  const createdAt = new Date("2026-10-05T12:00:00.000Z");
  const row = (id: string, orderId: string, code: string, amountCents: number) => ({
    id,
    orderId,
    code,
    label: code,
    jurisdiction: "US/MN",
    rateBps: 300,
    base: "TICKET_FACE",
    collector: "PLATFORM",
    taxableAmountCents: 3500,
    amountCents,
    createdAt,
    somePrismaOnlyField: "must not leak",
  });

  it("reads every order's lines in ONE findMany and groups them by order, in row order", async () => {
    const { prisma, findMany } = createPrisma([
      row("line-1", ORDER_ID, "SALES", 349),
      row("line-2", OTHER_ORDER_ID, "SALES", 100),
      row("line-3", ORDER_ID, "MPLS_ENTERTAINMENT", 105),
    ]);

    const byOrder = await makeOrdersRepo(prisma).listTaxLinesByOrderIds([
      ORDER_ID,
      OTHER_ORDER_ID,
      ORDER_ID,
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { orderId: { in: [ORDER_ID, OTHER_ORDER_ID] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect([...byOrder.keys()].sort()).toEqual([ORDER_ID, OTHER_ORDER_ID].sort());
    expect(byOrder.get(ORDER_ID)!.map((l) => l.code)).toEqual([
      "SALES",
      "MPLS_ENTERTAINMENT",
    ]);
    expect(byOrder.get(OTHER_ORDER_ID)).toHaveLength(1);
    expect(byOrder.get(ORDER_ID)![0]).toEqual({
      id: "line-1",
      orderId: ORDER_ID,
      code: "SALES",
      label: "SALES",
      jurisdiction: "US/MN",
      rateBps: 300,
      base: "TICKET_FACE",
      collector: "PLATFORM",
      taxableAmountCents: 3500,
      amountCents: 349,
      createdAt,
    });
  });

  it("orders with no lines are absent from the map", async () => {
    const { prisma } = createPrisma([row("line-1", ORDER_ID, "SALES", 349)]);
    const byOrder = await makeOrdersRepo(prisma).listTaxLinesByOrderIds([
      ORDER_ID,
      OTHER_ORDER_ID,
    ]);
    expect(byOrder.has(OTHER_ORDER_ID)).toBe(false);
  });

  it("empty input returns an empty map and issues no query", async () => {
    const { prisma, findMany } = createPrisma();
    const byOrder = await makeOrdersRepo(prisma).listTaxLinesByOrderIds([]);
    expect(byOrder.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
