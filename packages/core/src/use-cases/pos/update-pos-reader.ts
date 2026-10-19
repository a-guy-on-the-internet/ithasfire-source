import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_ADMIN_ROLES, requireOrgMembership } from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const updatePosReaderInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orgId: z.string().uuid(),
  posReaderId: z.string().uuid(),
  label: z.string().trim().min(1).max(64).optional(),
  /**
   * `null` clears the venue pin, `undefined` leaves it alone. The repo layer
   * distinguishes the two — don't collapse them.
   */
  placeId: z.string().uuid().nullable().optional(),
});

export type UpdatePosReaderInput = z.infer<typeof updatePosReaderInputSchema>;

export const updatePosReaderOutputSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  placeId: z.string().nullable(),
});

export type UpdatePosReaderOutput = z.infer<typeof updatePosReaderOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type UpdatePosReaderDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Renames a reader or moves its venue pin. Local metadata only — the Stripe
 * registration is untouched, so this never affects the ability to take money.
 *
 * Auth: ORG_ADMIN_ROLES, matching pair/unpair.
 *
 * Note the label deliberately does NOT propagate to Stripe. Keeping the two in
 * sync would mean a failed Stripe call blocking a rename; the Stripe label is
 * only ever read in the Stripe dashboard, so drift there is harmless.
 */
export async function updatePosReader(
  deps: UpdatePosReaderDeps,
  rawInput: unknown,
): Promise<UpdatePosReaderOutput> {
  const input = parseInput(updatePosReaderInputSchema, rawInput);

  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_ADMIN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const reader = await deps.repos.posReaders.getById({ id: input.posReaderId });
  if (!reader) {
    throw fail("POS_READER_NOT_FOUND");
  }
  if (reader.orgId !== input.orgId) {
    throw fail("POS_READER_ORG_MISMATCH");
  }

  if (input.placeId) {
    const place = await deps.repos.places.getById(input.placeId);
    if (!place) {
      throw fail("PLACE_NOT_FOUND");
    }
  }

  const updated = await deps.repos.posReaders.update({
    id: reader.id,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
  });

  deps.logger?.info("pos.reader.updated", {
    actorHumanId: input.actorHumanId,
    orgId: input.orgId,
    posReaderId: reader.id,
  });

  return updatePosReaderOutputSchema.parse({
    id: updated.id,
    label: updated.label,
    placeId: updated.placeId,
  });
}
