import { describe, expect, it, vi } from "vitest";

import { makePendingTicketTransfersRepo } from "../pending-ticket-transfers";
import type { PrismaClientOrTx } from "../types";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const TICKET_ID = "44444444-4444-4444-8444-444444444444";

describe("makePendingTicketTransfersRepo.expireLapsedForTicket", () => {
  it("expires only this ticket's PENDING rows strictly before now", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      pendingTicketTransfer: { updateMany },
    } as unknown as PrismaClientOrTx;

    const n = await makePendingTicketTransfersRepo(prisma).expireLapsedForTicket(
      TICKET_ID,
      NOW,
    );

    expect(n).toBe(1);
    // Strict `lt`: AT expiresAt the claim path still accepts the invite, so
    // it must not be retired here (claim-pending-transfer: expiresAt < now).
    expect(updateMany).toHaveBeenCalledWith({
      where: { ticketId: TICKET_ID, status: "PENDING", expiresAt: { lt: NOW } },
      data: { status: "EXPIRED" },
    });
  });
});
