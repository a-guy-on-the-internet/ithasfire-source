import { z } from "zod";

import { authZRoleSchema } from "@th/ports/authz";
import type { AuthNPort } from "@th/ports/authn";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** OWNER is excluded — only the principal "owns" their account. */
const delegateRoleSchema = authZRoleSchema.exclude(["OWNER"]);

export const updateHumanDelegateRoleInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    principalId: z.string().uuid(),
    targetHumanId: z.string().uuid(),
    newRole: delegateRoleSchema,
  })
  .strict();

export const updateHumanDelegateRoleOutputSchema = z
  .object({ ok: z.literal(true), changed: z.boolean() })
  .strict();

export type UpdateHumanDelegateRoleInput = z.infer<
  typeof updateHumanDelegateRoleInputSchema
>;
export type UpdateHumanDelegateRoleOutput = z.infer<
  typeof updateHumanDelegateRoleOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type UpdateHumanDelegateRoleDeps = {
  repos: Repos;
  authn: AuthNPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function updateHumanDelegateRole(
  deps: UpdateHumanDelegateRoleDeps,
  rawInput: unknown,
): Promise<UpdateHumanDelegateRoleOutput> {
  const input = parseInput(updateHumanDelegateRoleInputSchema, rawInput);

  // Only the principal can change delegate roles.
  if (input.actorHumanId !== input.principalId) {
    throw fail("INSUFFICIENT_ROLE", { meta: { action: "update" } });
  }

  const changed = await deps.repos.tx(async (tx) => {
    const existing = await tx.humanDelegates.getDelegation({
      principalId: input.principalId,
      delegateId: input.targetHumanId,
    });

    if (!existing) {
      throw fail("DELEGATION_NOT_FOUND");
    }

    // No-op if role is already the target.
    if (existing.role === input.newRole) {
      return false;
    }

    await tx.humanDelegates.addDelegate({
      principalId: input.principalId,
      delegateId: input.targetHumanId,
      role: input.newRole,
    });

    const now = deps.clock.now();
    await tx.audit.log({
      entity: "human",
      entityId: input.principalId,
      action: "human.delegate_role_updated",
      data: {
        actorHumanId: input.actorHumanId,
        targetHumanId: input.targetHumanId,
        previousRole: existing.role,
        newRole: input.newRole,
      },
      at: now,
    });

    return true;
  });

  return updateHumanDelegateRoleOutputSchema.parse({ ok: true, changed });
}
