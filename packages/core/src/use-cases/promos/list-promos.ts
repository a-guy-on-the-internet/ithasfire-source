import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  promoKindSchema,
  promoScopeSchema,
  promoStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_ANY_ROLE } from "../../lib/rbac";
import { isEditDelegateOfHumanOwner } from "../../lib/event-edit-rights";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listPromosInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
  ownerId: z.string().uuid(),
  status: promoStatusSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const promoWithStatsSchema = z.object({
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
  totalRedemptions: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const listPromosOutputSchema = z.object({
  items: z.array(promoWithStatsSchema),
  total: z.number().int(),
});

export type ListPromosInput = z.infer<typeof listPromosInputSchema>;
export type ListPromosOutput = z.infer<typeof listPromosOutputSchema>;

export type ListPromosDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function listPromos(
  deps: ListPromosDeps,
  rawInput: unknown,
): Promise<ListPromosOutput> {
  const input = parseInput(listPromosInputSchema, rawInput);

  // ── RBAC ──────────────────────────────────────────────────────────────
  // An edit-role delegate of a HUMAN owner reads the principal's promos (the
  // share dialog in the principal's event builder; owner ruling 2026-09-28).
  if (
    !(await isEditDelegateOfHumanOwner(
      deps.repos.authz,
      input,
      input.actorHumanId,
    ))
  ) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });
  }

  const result = await deps.repos.promos.listByScope({
    // Owner-wide "self" scope: ORG for organizations, HUMAN for direct
    // sellers. scopeId is the owner in both cases.
    scope: input.ownerType === "ORGANIZATION" ? "ORG" : "HUMAN",
    scopeId: input.ownerId,
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  return listPromosOutputSchema.parse(result);
}
