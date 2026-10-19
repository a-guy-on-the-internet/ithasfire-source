import { z } from "zod";

import { authZRoleSchema } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const delegateItemSchema = z.object({
  humanId: z.string().uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: authZRoleSchema,
  joinedAt: z.coerce.date(),
});

export const listHumanDelegatesInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    principalId: z.string().uuid(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export const listHumanDelegatesOutputSchema = z
  .object({
    items: z.array(delegateItemSchema),
    total: z.number().int(),
  })
  .strict();

export type ListHumanDelegatesInput = z.infer<
  typeof listHumanDelegatesInputSchema
>;
export type ListHumanDelegatesOutput = z.infer<
  typeof listHumanDelegatesOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ListHumanDelegatesDeps = {
  repos: Pick<Repos, "humanDelegates">;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only the principal (account owner) can list their delegates.
 *
 * `email` is safe to return because a delegation now exists only once the
 * delegate accepted a link bound to that very email (`acceptDelegateInvite`);
 * the consent-free `addHumanDelegate` was removed (security review F3).
 */
export async function listHumanDelegates(
  deps: ListHumanDelegatesDeps,
  rawInput: unknown,
): Promise<ListHumanDelegatesOutput> {
  const input = parseInput(listHumanDelegatesInputSchema, rawInput);

  // Only the principal themselves can list their delegates.
  if (input.actorHumanId !== input.principalId) {
    throw fail("INSUFFICIENT_ROLE", { meta: { action: "list" } });
  }

  const result = await deps.repos.humanDelegates.listDelegates({
    principalId: input.principalId,
    limit: input.limit,
    offset: input.offset,
  });

  return listHumanDelegatesOutputSchema.parse(result);
}
