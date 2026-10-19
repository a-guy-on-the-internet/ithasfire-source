import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";

import { parseInput } from "../../lib/io";
import { ensureEmailVerified } from "../_helpers/ensure-email-verified";

// ── Schemas ────────────────────────────────────────────────────────────────

export const searchTransferRecipientsInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    query: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(20).optional().default(10),
  })
  .strict();

export const searchTransferRecipientsOutputSchema = z.object({
  results: z.array(
    z.object({
      humanId: z.string().uuid(),
      displayName: z.string().nullable(),
      username: z.string().nullable(),
      email: z.string(),
      image: z.string().nullable(),
    }),
  ),
});

export type SearchTransferRecipientsInput = z.infer<
  typeof searchTransferRecipientsInputSchema
>;
export type SearchTransferRecipientsOutput = z.infer<
  typeof searchTransferRecipientsOutputSchema
>;

export type SearchTransferRecipientsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ── Use case ───────────────────────────────────────────────────────────────

export async function searchTransferRecipients(
  deps: SearchTransferRecipientsDeps,
  rawInput: unknown,
): Promise<SearchTransferRecipientsOutput> {
  const input = parseInput(searchTransferRecipientsInputSchema, rawInput);

  // Sender must have verified email
  await ensureEmailVerified(deps.repos, input.actorHumanId);

  const matches = await deps.repos.humans.searchByQuery(input.query, {
    limit: input.limit,
    excludeHumanId: input.actorHumanId,
  });

  return searchTransferRecipientsOutputSchema.parse({
    results: matches.map((m) => ({
      humanId: m.human.id,
      displayName: m.identity.displayUsername ?? m.human.name ?? null,
      username: m.identity.username,
      email: m.identity.email,
      image: m.identity.image,
    })),
  });
}
