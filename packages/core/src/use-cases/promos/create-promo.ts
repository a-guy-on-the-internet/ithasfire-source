import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { promoKindSchema, promoScopeSchema } from "@th/schema";

import { parseInput } from "../../lib/io";
import { requireOwnerAccess, ORG_FINANCE_ROLES } from "../../lib/rbac";
import { ensurePromoScopeOwnedByOwner } from "./scope-ownership";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const createPromoInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
  ownerId: z.string().uuid(),
  code: z.string().min(1).max(64),
  kind: promoKindSchema,
  value: z.number().int().min(1),
  currency: z.string().length(3).toLowerCase().default("usd"),
  scope: promoScopeSchema.default("ORG"),
  scopeId: z.string().uuid().nullish(),
  startsAt: z.coerce.date().nullish(),
  endsAt: z.coerce.date().nullish(),
  maxRedemptions: z.number().int().min(1).nullish(),
  maxRedemptionsPerHuman: z.number().int().min(1).nullish(),
  minOrderCents: z.number().int().min(0).default(0),
  maxDiscountCents: z.number().int().min(1).nullish(),
  stackable: z.boolean().default(false),
  /** Public codes may be auto-applied from shareable URLs. Defaults to false. */
  isPublic: z.boolean().default(false),
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

export const createPromoOutputSchema = promoOutputSchema;

export type CreatePromoInput = z.infer<typeof createPromoInputSchema>;
export type CreatePromoOutput = z.infer<typeof createPromoOutputSchema>;

export type CreatePromoDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function createPromo(
  deps: CreatePromoDeps,
  rawInput: unknown,
): Promise<CreatePromoOutput> {
  const input = parseInput(createPromoInputSchema, rawInput);

  // ── GLOBAL scope is disabled ──────────────────────────────────────────
  // Schema retains the enum value for forward-compatibility, but creating
  // a GLOBAL-scoped promo is intentionally not exposed: it silently shifts
  // organizer payouts (the discount comes off the organizer's revenue, not
  // the platform's margin) and the blast radius of a leak is catastrophic.
  // The honest version of this feature is a platform-funded user credit
  // (`UserCredit { humanId, amountCents, ... }`), not a shareable code.
  if (input.scope === "GLOBAL") {
    throw fail("GLOBAL_SCOPE_DISABLED");
  }

  // ── RBAC ──────────────────────────────────────────────────────────────
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  // ── Derive scope ──────────────────────────────────────────────────────
  // "ORG" doubles as the owner-wide default in the input schema. For HUMAN
  // owners (direct sellers) the owner-wide scope is "HUMAN" — silently map
  // it so the tRPC/UI surface stays backward compatible. Both ORG and HUMAN
  // are "self" scopes: their scopeId is always the ownerId.
  const scope =
    input.scope === "ORG" && input.ownerType === "HUMAN"
      ? ("HUMAN" as const)
      : input.scope;
  const scopeId =
    scope === "ORG" || scope === "HUMAN"
      ? input.ownerId
      : (input.scopeId ?? null);

  // GLOBAL is rejected above; every other scope must carry a scopeId.
  if (!scopeId) {
    throw fail("SCOPE_REQUIRES_SCOPE_ID");
  }

  await ensurePromoScopeOwnedByOwner({
    repos: deps.repos,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    scope,
    scopeId,
    mode: "create",
  });

  // ── Date validation ───────────────────────────────────────────────────
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) {
    throw fail("END_BEFORE_START");
  }

  // ── Create ────────────────────────────────────────────────────────────
  const record = await deps.repos.promos.create({
    code: input.code,
    kind: input.kind,
    value: input.value,
    currency: input.currency,
    scope,
    scopeId,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    maxRedemptionsPerHuman: input.maxRedemptionsPerHuman ?? null,
    minOrderCents: input.minOrderCents,
    maxDiscountCents: input.maxDiscountCents ?? null,
    stackable: input.stackable,
    isPublic: input.isPublic,
  });

  deps.logger?.info("createPromo.succeeded", {
    promoId: record.id,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    code: record.code,
    scope,
  });

  return createPromoOutputSchema.parse(record);
}
