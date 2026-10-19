import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { describeError, parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ── Schemas ────────────────────────────────────────────────────────────────

export const cancelPendingTransferInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    pendingTransferId: z.uuid(),
  })
  .strict();

export const cancelPendingTransferOutputSchema = z
  .object({
    cancelled: z.boolean(),
  })
  .strict();

export type CancelPendingTransferInput = z.infer<
  typeof cancelPendingTransferInputSchema
>;
export type CancelPendingTransferOutput = z.infer<
  typeof cancelPendingTransferOutputSchema
>;

export type CancelPendingTransferDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function cancelPendingTransfer(
  deps: CancelPendingTransferDeps,
  rawInput: unknown,
): Promise<CancelPendingTransferOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelPendingTransfer" });

  const execute = async () => {
    const input = parseInput(cancelPendingTransferInputSchema, rawInput);

    const result = await deps.repos.tx(async (tx) => {
      // We need to find the pending transfer by looking it up via a query
      // For now, the simplest approach: look up by ID directly
      // (We'd need a getById on the repo; let's use the token approach or add getById)
      // Actually, let's find all pending transfers from this actor and filter
      // For the cancel flow, the sender knows the pendingTransferId from the UI.

      // We need a getById — but for the initial implementation, let's use a simpler path:
      // The front-end has the pending transfer ID, so we can look it up.
      // Let's add a simple query via the existing token-based pattern.

      // For now, we'll trust the pendingTransferId from input since:
      // 1. We verify the fromHumanId matches the actor
      // 2. We verify the status is still PENDING

      const pending = await tx.pendingTicketTransfers.getById(
        input.pendingTransferId,
      );
      if (!pending) {
        throw fail("PENDING_TRANSFER_NOT_FOUND");
      }
      if (pending.fromHumanId !== input.actorHumanId) {
        throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "transfer" } });
      }
      if (pending.status !== "PENDING") {
        throw {
          code: "conflict",
          message: `pending_transfer_${pending.status.toLowerCase()}`,
        } as const;
      }

      const now = deps.clock.now();
      await tx.pendingTicketTransfers.markCancelled(pending.id, now);

      await tx.audit.log({
        entity: "ticket",
        entityId: pending.ticketId,
        action: "transfer.email_cancelled",
        data: {
          pendingTransferId: pending.id,
          fromHumanId: input.actorHumanId,
          recipientEmail: pending.recipientEmail,
        },
        at: now,
      });

      return { cancelled: true };
    });

    return cancelPendingTransferOutputSchema.parse(result);
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelPendingTransfer", execute);
  }

  return execute();
}
