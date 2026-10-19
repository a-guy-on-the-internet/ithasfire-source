import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";

// ── Schemas ────────────────────────────────────────────────────────────────

export const getPendingTransfersInputSchema = z
  .object({
    actorHumanId: z.uuid(),
  })
  .strict();

const pendingTransferItemSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  recipientEmail: z.string(),
  reason: z.string(),
  token: z.string(),
  status: z.string(),
  expiresAt: z.date(),
  createdAt: z.date(),
});

export const getPendingTransfersOutputSchema = z
  .object({
    transfers: z.array(pendingTransferItemSchema),
  })
  .strict();

export type GetPendingTransfersInput = z.infer<
  typeof getPendingTransfersInputSchema
>;
export type GetPendingTransfersOutput = z.infer<
  typeof getPendingTransfersOutputSchema
>;

export type GetPendingTransfersDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function getPendingTransfers(
  deps: GetPendingTransfersDeps,
  rawInput: unknown,
): Promise<GetPendingTransfersOutput> {
  const input = parseInput(getPendingTransfersInputSchema, rawInput);

  const pending =
    await deps.repos.pendingTicketTransfers.findPendingByFromHumanId(
      input.actorHumanId,
    );

  return getPendingTransfersOutputSchema.parse({
    transfers: pending.map((p) => ({
      id: p.id,
      ticketId: p.ticketId,
      recipientEmail: p.recipientEmail,
      reason: p.reason,
      token: p.token,
      status: p.status,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
    })),
  });
}
