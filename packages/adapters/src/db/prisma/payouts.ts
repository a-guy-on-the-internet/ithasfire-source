import type { PayoutsRepo } from "@th/ports/repos/payouts";

import type { PrismaClientOrTx } from "./types";

export function makePayoutsRepo(p: PrismaClientOrTx): PayoutsRepo {
  return {
    create: async (input) => {
      const row = await p.payout.create({
        data: {
          scheduledFor: input.scheduledFor,
          status: "scheduled",
        },
        select: {
          id: true,
          scheduledFor: true,
          status: true,
          canceledAt: true,
          startedAt: true,
          completedAt: true,
          processorBatchId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return {
        ...row,
        status: row.status as
          | "scheduled"
          | "running"
          | "completed"
          | "failed"
          | "canceled",
        canceledAt: row.canceledAt ?? null,
        startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null,
        processorBatchId: row.processorBatchId ?? null,
      };
    },

    listDue: async (now, limit) => {
      const rows = await p.payout.findMany({
        where: {
          status: "scheduled",
          scheduledFor: { lte: now },
          canceledAt: null,
        },
        orderBy: { scheduledFor: "asc" },
        take: limit,
        select: { id: true, scheduledFor: true },
      });
      return rows;
    },

    markRunning: async (payoutId, startedAt) => {
      await p.payout.update({
        where: { id: payoutId },
        data: { status: "running", startedAt },
      });
    },

    markCompleted: async (payoutId, completedAt) => {
      await p.payout.update({
        where: { id: payoutId },
        data: { status: "completed", completedAt },
      });
    },

    markFailed: async (payoutId, failedAt, reason) => {
      await p.payout.update({
        where: { id: payoutId },
        data: {
          status: "failed",
          completedAt: failedAt,
          processorBatchId: null,
        },
      });

      // Failure details are tracked on PayoutItem(s) today.
      void reason;
    },

    cancel: async (payoutId, canceledAt) => {
      await p.payout.update({
        where: { id: payoutId },
        data: { status: "canceled", canceledAt },
      });
    },
  };
}
