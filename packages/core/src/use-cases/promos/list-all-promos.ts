import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import {
  promoKindSchema,
  promoScopeSchema,
  promoStatusSchema,
} from "@th/schema";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listAllPromosInputSchema = z.object({
  scope: promoScopeSchema.optional(),
  scopeId: z.string().uuid().optional(),
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

export const listAllPromosOutputSchema = z.object({
  items: z.array(promoWithStatsSchema),
  total: z.number().int(),
});

export type ListAllPromosInput = z.infer<typeof listAllPromosInputSchema>;
export type ListAllPromosOutput = z.infer<typeof listAllPromosOutputSchema>;

export type ListAllPromosDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case (platform-level — staff guard applied at transport layer)
// ─────────────────────────────────────────────────────────────────────────────

export async function listAllPromos(
  deps: ListAllPromosDeps,
  rawInput: unknown,
): Promise<ListAllPromosOutput> {
  const input = parseInput(listAllPromosInputSchema, rawInput);

  const result = await deps.repos.promos.listByScope({
    scope: input.scope,
    scopeId: input.scopeId,
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });

  return listAllPromosOutputSchema.parse(result);
}
