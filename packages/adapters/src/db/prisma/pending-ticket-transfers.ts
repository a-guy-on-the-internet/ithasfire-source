import type {
  CreatePendingTicketTransferInput,
  PendingTicketTransferRecord,
  PendingTicketTransfersRepo,
} from "@th/ports/repos/pending-ticket-transfers";

import type { PrismaClientOrTx } from "./types";

export function makePendingTicketTransfersRepo(
  p: PrismaClientOrTx,
): PendingTicketTransfersRepo {
  return {
    create: async (input: CreatePendingTicketTransferInput) => {
      const row = await p.pendingTicketTransfer.create({
        data: {
          ticketId: input.ticketId,
          fromHumanId: input.fromHumanId,
          recipientEmail: input.recipientEmail,
          reason: input.reason,
          token: input.token,
          expiresAt: input.expiresAt,
        },
      });
      return mapRow(row);
    },

    getById: async (id: string) => {
      const row = await p.pendingTicketTransfer.findUnique({
        where: { id },
      });
      return row ? mapRow(row) : null;
    },

    getByToken: async (token: string) => {
      const row = await p.pendingTicketTransfer.findUnique({
        where: { token },
      });
      return row ? mapRow(row) : null;
    },

    findPendingByEmail: async (email: string) => {
      const rows = await p.pendingTicketTransfer.findMany({
        where: {
          recipientEmail: { equals: email, mode: "insensitive" },
          status: "PENDING",
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(mapRow);
    },

    findPendingByTicketId: async (ticketId: string) => {
      const row = await p.pendingTicketTransfer.findFirst({
        where: { ticketId, status: "PENDING" },
      });
      return row ? mapRow(row) : null;
    },

    markClaimed: async (
      id: string,
      claimedByHumanId: string,
      claimedAt: Date,
    ) => {
      await p.pendingTicketTransfer.update({
        where: { id },
        data: {
          status: "CLAIMED",
          claimedByHumanId,
          claimedAt,
        },
      });
    },

    markCancelled: async (id: string, cancelledAt: Date) => {
      await p.pendingTicketTransfer.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelledAt,
        },
      });
    },

    findPendingByFromHumanId: async (fromHumanId: string) => {
      const rows = await p.pendingTicketTransfer.findMany({
        where: {
          fromHumanId,
          status: "PENDING",
        },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapRow);
    },

    expireLapsedForTicket: async (ticketId: string, now: Date) => {
      const result = await p.pendingTicketTransfer.updateMany({
        where: {
          ticketId,
          status: "PENDING",
          expiresAt: { lt: now },
        },
        data: { status: "EXPIRED" },
      });
      return result.count;
    },

    expireStale: async (now: Date) => {
      const result = await p.pendingTicketTransfer.updateMany({
        where: {
          status: "PENDING",
          expiresAt: { lte: now },
        },
        data: { status: "EXPIRED" },
      });
      return result.count;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapRow(row: any): PendingTicketTransferRecord {
  return {
    id: row.id,
    ticketId: row.ticketId,
    fromHumanId: row.fromHumanId,
    recipientEmail: row.recipientEmail,
    reason: row.reason,
    token: row.token,
    status: row.status,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    claimedByHumanId: row.claimedByHumanId,
    cancelledAt: row.cancelledAt,
  };
}
