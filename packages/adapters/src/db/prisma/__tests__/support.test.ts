import { describe, expect, it, vi } from "vitest";

import { makeSupportThreadRepo } from "../support";
import type { PrismaClientOrTx } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// scrubHumanSupportContent — GDPR/CCPA erasure of a deleted human's free-text.
//
// These exercise the adapter against a mocked Prisma client (the house pattern
// for db/prisma adapter tests — see disputes.test.ts). They assert the exact
// updateMany shapes and ordering; DB-level FK SET NULL behavior is covered by
// the migration, not unit-tested here (no integration DB harness exists for
// support — noted in the change report).
// ─────────────────────────────────────────────────────────────────────────────

const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function createPrisma() {
  const updateMany = vi.fn();
  const prisma = {
    supportMessage: { updateMany },
  } as unknown as PrismaClientOrTx;
  return { prisma, updateMany };
}

describe("makeSupportThreadRepo.scrubHumanSupportContent", () => {
  it("tombstones USER bodies + nulls their author link, then clears remaining author links", async () => {
    const { prisma, updateMany } = createPrisma();
    // First call: USER free-text scrub. Second: remaining non-USER links.
    updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });

    const repo = makeSupportThreadRepo(prisma);
    const result = await repo.scrubHumanSupportContent({
      humanId: HUMAN_ID,
      tombstone: "[deleted]",
    });

    // 1) USER messages: body tombstoned AND authorHumanId nulled.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { authorHumanId: HUMAN_ID, authorType: "USER" },
      data: { body: "[deleted]", authorHumanId: null },
    });

    // 2) Remaining author links by this human (e.g. HUMAN_AGENT): id nulled,
    //    body left intact (no tombstone).
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { authorHumanId: HUMAN_ID },
      data: { authorHumanId: null },
    });

    // Ordering: USER scrub MUST run before the remaining-links pass, otherwise
    // the second pass would re-null already-nulled USER rows and the counts
    // would double-count.
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      updateMany.mock.invocationCallOrder[1]!,
    );

    expect(result).toEqual({ messagesScrubbed: 2, authorLinksCleared: 1 });
  });

  it("returns zero counts when the human authored no support messages", async () => {
    const { prisma, updateMany } = createPrisma();
    updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    const repo = makeSupportThreadRepo(prisma);
    const result = await repo.scrubHumanSupportContent({
      humanId: HUMAN_ID,
      tombstone: "[deleted]",
    });

    expect(result).toEqual({ messagesScrubbed: 0, authorLinksCleared: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteResolvedThreadsBefore — retention purge. Selects up to `limit` eligible
// thread ids (RESOLVED + resolvedAt before the cutoff), then deletes by id so
// their messages cascade. Mocked-Prisma assertions over the exact query shapes.
// ─────────────────────────────────────────────────────────────────────────────

const BEFORE = new Date("2025-06-25T00:00:00.000Z");

function createPurgePrisma() {
  const findMany = vi.fn();
  const deleteMany = vi.fn();
  const prisma = {
    supportThread: { findMany, deleteMany },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany, deleteMany };
}

describe("makeSupportThreadRepo.deleteResolvedThreadsBefore", () => {
  it("selects eligible ids then deletes by id, returning the deleted count", async () => {
    const { prisma, findMany, deleteMany } = createPurgePrisma();
    findMany.mockResolvedValueOnce([{ id: "t1" }, { id: "t2" }]);
    deleteMany.mockResolvedValueOnce({ count: 2 });

    const repo = makeSupportThreadRepo(prisma);
    const result = await repo.deleteResolvedThreadsBefore({
      before: BEFORE,
      limit: 500,
    });

    // (a) the id-selection query: RESOLVED + resolvedAt set AND before cutoff,
    //     bounded by limit, oldest-resolved first, ids only.
    expect(findMany).toHaveBeenCalledWith({
      where: { status: "RESOLVED", resolvedAt: { not: null, lt: BEFORE } },
      select: { id: true },
      take: 500,
      orderBy: { resolvedAt: "asc" },
    });

    // (b) the bounded delete by the selected ids.
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["t1", "t2"] } },
    });

    expect(result).toEqual({ deleted: 2 });
  });

  it("short-circuits without deleting when no thread is eligible", async () => {
    const { prisma, findMany, deleteMany } = createPurgePrisma();
    findMany.mockResolvedValueOnce([]);

    const repo = makeSupportThreadRepo(prisma);
    const result = await repo.deleteResolvedThreadsBefore({
      before: BEFORE,
      limit: 500,
    });

    // (c) empty backlog → never call deleteMany, return zero.
    expect(deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// listThreads → SupportThreadStaffRecord.orderRef
//
// BEHAVIOUR CHANGE (Order.shortId contraction): the operator inbox used to
// label a thread's order with `Order.shortId` and fall back to the raw UUID.
// `shortId` is gone from the code, so the label is now the ONE platform order
// code — `formatOrderCode(Order.id)`, the 8-hex tail uppercased — which is
// byte-identical to what the order page, the admin dashboard and admin search
// render, and is what admin search accepts as a query.
// ─────────────────────────────────────────────────────────────────────────────

const THREAD_ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";

function createInboxPrisma(order: { id: string } | null) {
  const findMany = vi.fn(async () => [
    {
      id: "thread-1",
      humanId: null,
      eventId: null,
      orderId: order?.id ?? null,
      status: "OPEN",
      source: "WEB",
      lastMessageAt: new Date("2026-08-01T00:00:00.000Z"),
      resolvedAt: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
      human: null,
      event: null,
      order,
      messages: [],
    },
  ]);
  const count = vi.fn(async () => 1);
  const prisma = {
    supportThread: { findMany, count },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

describe("makeSupportThreadRepo.listThreads orderRef", () => {
  it("labels the order with the 8-hex order code, uppercased", async () => {
    const { prisma } = createInboxPrisma({ id: THREAD_ORDER_ID });

    const result = await makeSupportThreadRepo(prisma).listThreads({
      limit: 20,
      offset: 0,
    });

    // Exactly `#{order.id.slice(-8).toUpperCase()}` minus the '#'.
    expect(result.items[0]!.orderRef).toBe("DB21B2C3");
    expect(result.items[0]!.orderRef).toBe(
      THREAD_ORDER_ID.slice(-8).toUpperCase(),
    );
  });

  it("never falls back to the raw UUID — the code is always derivable", async () => {
    const { prisma } = createInboxPrisma({ id: THREAD_ORDER_ID });

    const result = await makeSupportThreadRepo(prisma).listThreads({
      limit: 20,
      offset: 0,
    });

    expect(result.items[0]!.orderRef).not.toBe(THREAD_ORDER_ID);
  });

  it("is null when the thread has no order", async () => {
    const { prisma } = createInboxPrisma(null);

    const result = await makeSupportThreadRepo(prisma).listThreads({
      limit: 20,
      offset: 0,
    });

    expect(result.items[0]!.orderRef).toBeNull();
  });

  it("does NOT select the retired shortId column", async () => {
    const { prisma, findMany } = createInboxPrisma({ id: THREAD_ORDER_ID });

    await makeSupportThreadRepo(prisma).listThreads({ limit: 20, offset: 0 });

    const select = (findMany.mock.calls[0]![0] as any).select;
    expect(select.order).toEqual({ select: { id: true } });
    expect(JSON.stringify(select)).not.toContain("shortId");
  });
});
