import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  promoKindSchema,
  promoScopeSchema,
  promoStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { ensurePromoScopeOwnedByOwner } from "./scope-ownership";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const updatePromoInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
  ownerId: z.string().uuid(),
  promoId: z.string().uuid(),
  code: z.string().min(1).max(64).optional(),
  kind: promoKindSchema.optional(),
  value: z.number().int().min(1).optional(),
  currency: z.string().length(3).toLowerCase().optional(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  maxRedemptions: z.number().int().min(1).nullish(),
  maxRedemptionsPerHuman: z.number().int().min(1).nullish(),
  minOrderCents: z.number().int().min(0).optional(),
  maxDiscountCents: z.number().int().min(1).nullish(),
  stackable: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  status: promoStatusSchema.optional(),
});

const promoOutputSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  codeNormalized: z.string(),
  kind: promoKindSchema,
  value: z.number(),
  currency: z.string(),
  scope: promoScopeSchema,
  scopeId: z.string().nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  maxRedemptions: z.number().nullish(),
  maxRedemptionsPerHuman: z.number().nullish(),
  minOrderCents: z.number(),
  maxDiscountCents: z.number().nullish(),
  stackable: z.boolean(),
  isPublic: z.boolean(),
  status: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const updatePromoOutputSchema = promoOutputSchema;

export type UpdatePromoInput = z.infer<typeof updatePromoInputSchema>;
export type UpdatePromoOutput = z.infer<typeof updatePromoOutputSchema>;

export type UpdatePromoDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function updatePromo(
  deps: UpdatePromoDeps,
  rawInput: unknown,
): Promise<UpdatePromoOutput> {
  const input = parseInput(updatePromoInputSchema, rawInput);

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

  // ── Date validation ───────────────────────────────────────────────────
  const effectiveStart =
    input.startsAt !== undefined ? input.startsAt : existing.startsAt;
  const effectiveEnd =
    input.endsAt !== undefined ? input.endsAt : existing.endsAt;
  if (effectiveStart && effectiveEnd && effectiveEnd <= effectiveStart) {
    throw fail("END_BEFORE_START");
  }

  // ── Update ────────────────────────────────────────────────────────────
  const record = await deps.repos.promos.update({
    id: input.promoId,
    code: input.code,
    kind: input.kind,
    value: input.value,
    currency: input.currency,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    maxRedemptions: input.maxRedemptions,
    maxRedemptionsPerHuman: input.maxRedemptionsPerHuman,
    minOrderCents: input.minOrderCents,
    maxDiscountCents: input.maxDiscountCents,
    stackable: input.stackable,
    isPublic: input.isPublic,
    status: input.status,
  });

  deps.logger?.info("updatePromo.succeeded", {
    promoId: record.id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
  });

  return updatePromoOutputSchema.parse(record);
}
