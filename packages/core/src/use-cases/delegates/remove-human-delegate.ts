import { z } from "zod";

import type { AuthNPort } from "@th/ports/authn";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const removeHumanDelegateInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    principalId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
  })
  .strict();

export const removeHumanDelegateOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export type RemoveHumanDelegateInput = z.infer<
  typeof removeHumanDelegateInputSchema
>;
export type RemoveHumanDelegateOutput = z.infer<
  typeof removeHumanDelegateOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type RemoveHumanDelegateDeps = {
  repos: Repos;
  authn: AuthNPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function removeHumanDelegate(
  deps: RemoveHumanDelegateDeps,
  rawInput: unknown,
): Promise<RemoveHumanDelegateOutput> {
  const input = parseInput(removeHumanDelegateInputSchema, rawInput);

  // Only the principal can remove delegates from their own account.
  if (input.actorHumanId !== input.principalId) {
    throw fail("INSUFFICIENT_ROLE", { meta: { action: "remove" } });
  }

  await deps.repos.tx(async (tx) => {
    // Verify the delegation exists.
    const delegation = await tx.humanDelegates.getDelegation({
      principalId: input.principalId,
      delegateId: input.targetHumanId,
    });

    if (!delegation) {
      throw fail("DELEGATION_NOT_FOUND");
    }

    await tx.humanDelegates.removeDelegate({
      principalId: input.principalId,
      delegateId: input.targetHumanId,
    });

    const now = deps.clock.now();
    await tx.audit.log({
      entity: "human",
      entityId: input.principalId,
      action: "human.delegate_removed",
      data: {
        actorHumanId: input.actorHumanId,
        targetHumanId: input.targetHumanId,
        previousRole: delegation.role,
      },
      at: now,
    });
  });

  return removeHumanDelegateOutputSchema.parse({ ok: true });
}
