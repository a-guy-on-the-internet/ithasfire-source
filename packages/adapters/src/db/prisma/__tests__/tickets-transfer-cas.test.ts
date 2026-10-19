import { describe, expect, it, vi } from "vitest";

import { makeTicketsRepo } from "../tickets";
import type { PrismaClientOrTx } from "../types";

// ---------------------------------------------------------------------------
// A ticket transfer is a COMPARE-AND-SWAP, not a write.
//
// Money audit 2026-09-08 #19: transferability was decided by a read
// (`ensureTicketTransferable` / `claimPendingTransfer`) and applied by an
// unconditional `p.ticket.update` here, with nothing holding the row in
// between under READ COMMITTED. A refund landing in that window left BOTH
// sides "successful" — the sender refunded AND the recipient holding a live
// pass, because last write won.
//
// These are mock-Prisma tests for the QUERY SHAPE: that the predicates are
// actually in the `where`, that `updateMany` (the only form that can carry
// them) is what runs, and that the `TicketTransfer` provenance row is written
// ONLY when the swap won.
// ---------------------------------------------------------------------------

const TICKET_ID = "44444444-4444-4444-8444-444444444444";
const FROM_HUMAN_ID = "66666666-6666-4666-8666-666666666666";
const TO_HUMAN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "77777777-7777-4777-8777-777777777777";

function makePrisma(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const update = vi.fn(async () => ({}));
  const findUnique = vi.fn(async () => null);
  const ticketTransferCreate = vi.fn(async () => ({}));

  const prisma = {
    ticket: { updateMany, update, findUnique },
    ticketTransfer: { create: ticketTransferCreate },
  } as unknown as PrismaClientOrTx;

  return { prisma, updateMany, update, findUnique, ticketTransferCreate };
}

const baseInput = {
  ticketId: TICKET_ID,
  fromHumanId: FROM_HUMAN_ID,
  toHumanId: TO_HUMAN_ID,
  reason: "gift" as const,
  orderId: ORDER_ID,
};

describe("makeTicketsRepo transfer (compare-and-swap)", () => {
  it("swaps on id + owner + the expected status, and never on a blind update", async () => {
    const { prisma, updateMany, update, findUnique, ticketTransferCreate } =
      makePrisma(1);
    const repo = makeTicketsRepo(prisma);

    const moved = await repo.transfer({ ...baseInput, expectedStatus: "VALID" });

    expect(moved).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: TICKET_ID,
        ownerHumanId: FROM_HUMAN_ID,
        status: "VALID",
      },
      data: { ownerHumanId: TO_HUMAN_ID },
    });

    // The predicates ARE the guard, so the unconditional forms must not run:
    // `update` targets a unique row and cannot carry them, and the old
    // read-then-write `findUnique` is exactly the TOCTOU this replaced.
    expect(update).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();

    expect(ticketTransferCreate).toHaveBeenCalledWith({
      data: {
        ticketId: TICKET_ID,
        fromHumanId: FROM_HUMAN_ID,
        toHumanId: TO_HUMAN_ID,
        reason: "gift",
        orderId: ORDER_ID,
      },
    });
  });

  it("writes NO transfer row when the swap lost", async () => {
    const { prisma, updateMany, ticketTransferCreate } = makePrisma(0);
    const repo = makeTicketsRepo(prisma);

    const moved = await repo.transfer({ ...baseInput, expectedStatus: "VALID" });

    // A transfer that did not happen must not leave provenance saying it did —
    // the resale unwind's replay detection reads exactly those rows.
    expect(moved).toBe(false);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(ticketTransferCreate).not.toHaveBeenCalled();
  });

  it("keeps the owner predicate but omits the status one when no status is expected", async () => {
    const { prisma, updateMany } = makePrisma(1);
    const repo = makeTicketsRepo(prisma);

    // `unwindResaleOrderAfterRefund` passes no `expectedStatus` on purpose: it
    // hands a refunded resale ticket back to its seller whatever status the
    // buyer left it in, so a SCANNED ticket still goes home. Pinning VALID
    // there would strand the seller's ticket with the refunded buyer.
    const moved = await repo.transfer({ ...baseInput, reason: "admin" });

    expect(moved).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: TICKET_ID, ownerHumanId: FROM_HUMAN_ID },
      data: { ownerHumanId: TO_HUMAN_ID },
    });
    const where = updateMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect("status" in where).toBe(false);
  });

  it("maps the expected status through the DB enum mapper", async () => {
    const { prisma, updateMany } = makePrisma(1);
    const repo = makeTicketsRepo(prisma);

    await repo.transfer({ ...baseInput, expectedStatus: "LISTED" });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "LISTED" }),
      }),
    );
  });

  it("normalises a missing orderId to null on the provenance row", async () => {
    const { prisma, ticketTransferCreate } = makePrisma(1);
    const repo = makeTicketsRepo(prisma);

    await repo.transfer({
      ticketId: TICKET_ID,
      fromHumanId: FROM_HUMAN_ID,
      toHumanId: TO_HUMAN_ID,
      reason: "gift",
      expectedStatus: "VALID",
    });

    expect(ticketTransferCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ orderId: null }),
    });
  });
});
