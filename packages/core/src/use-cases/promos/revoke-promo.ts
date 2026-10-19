import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { ensurePromoScopeOwnedByOwner } from "./scope-ownership";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const revokePromoInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
  ownerId: z.string().uuid(),
  promoId: z.string().uuid(),
});

export const revokePromoOutputSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
});

export type RevokePromoInput = z.infer<typeof revokePromoInputSchema>;
export type RevokePromoOutput = z.infer<typeof revokePromoOutputSchema>;

export type RevokePromoDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function revokePromo(
  deps: RevokePromoDeps,
  rawInput: unknown,
): Promise<RevokePromoOutput> {
  const input = parseInput(revokePromoInputSchema, rawInput);

  // ── RBAC ──────────────────────────────────────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  // ── Verify promo belongs to this owner ────────────────────────────────
  const existing = await deps.repos.promos.getById(input.promoId);
  if (!existing) {
    throw fail("PROMO_NOT_FOUND");
  }
  await ensurePromoScopeOwnedByOwner({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope: existing.scope,
    scopeId: existing.scopeId,
    mode: "mutate",
  });

  if (existing.status === "ARCHIVED") {
    // Already archived — idempotent
    return { id: existing.id, status: existing.status };
  }

  // ── Archive ───────────────────────────────────────────────────────────
  const record = await deps.repos.promos.update({
    id: input.promoId,
    status: "ARCHIVED",
  });

  deps.logger?.info("revokePromo.succeeded", {
    promoId: record.id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  });

  return revokePromoOutputSchema.parse({
    id: record.id,
    status: record.status,
  });
}
