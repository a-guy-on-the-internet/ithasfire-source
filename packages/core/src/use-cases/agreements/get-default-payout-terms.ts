import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PayoutTermsRecord } from "@th/types/repos/payout-terms";
import { fail } from "@th/errors";
import {
  requireOrgMembership,
  ORG_EDIT_OR_FINANCE_ROLES,
} from "../../lib/rbac";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const entitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("org"),
    orgId: z.uuid(),
  }),
  z.object({
    kind: z.literal("place"),
    placeId: z.uuid(),
  }),
  z.object({
    kind: z.literal("human"),
    humanId: z.uuid(),
  }),
]);

export const getDefaultPayoutTermsInputSchema = z.object({
  actorHumanId: z.uuid(),
  entity: entitySchema,
});

export type GetDefaultPayoutTermsInput = z.infer<
  typeof getDefaultPayoutTermsInputSchema
>;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const getDefaultPayoutTermsOutputSchema = z.object({
  defaultPrimaryPayoutTermsId: z.string().nullable(),
  defaultResalePayoutTermsId: z.string().nullable(),
  primaryPayoutTerms: z.any().nullable(),
  resalePayoutTerms: z.any().nullable(),
});

export type GetDefaultPayoutTermsOutput = {
  defaultPrimaryPayoutTermsId: string | null;
  defaultResalePayoutTermsId: string | null;
  primaryPayoutTerms: PayoutTermsRecord | null;
  resalePayoutTerms: PayoutTermsRecord | null;
};

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export type GetDefaultPayoutTermsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

async function ensureOrgAccess(
  repos: Repos,
  orgId: string,
  actorHumanId: string,
): Promise<void> {
  const org = await repos.organizations.getById(orgId);
  if (!org)
    throw fail("ORGANIZATION_NOT_FOUND");

  await requireOrgMembership({
    repos,
    orgId,
    actorHumanId,
    roles: ORG_EDIT_OR_FINANCE_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });
}

async function ensurePlaceAccess(
  repos: Repos,
  placeId: string,
  actorHumanId: string,
): Promise<void> {
  const ctx = await repos.authz.getPlaceAccessContext(placeId);
  if (!ctx) throw fail("PLACE_NOT_FOUND");

  if (ctx.verifiedHumanOwnerIds.includes(actorHumanId)) return;

  for (const orgId of ctx.owningOrgIds) {
    const membership = await repos.authz.getOrgMembership({
      orgId,
      humanId: actorHumanId,
    });
    if (
      membership &&
      (ORG_EDIT_OR_FINANCE_ROLES as readonly string[]).includes(membership.role)
    )
      return;
  }

  throw fail("INSUFFICIENT_ROLE");
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function getDefaultPayoutTerms(
  deps: GetDefaultPayoutTermsDeps,
  rawInput: unknown,
): Promise<GetDefaultPayoutTermsOutput> {
  const input = getDefaultPayoutTermsInputSchema.parse(rawInput);

  let primaryId: string | null = null;
  let resaleId: string | null = null;

  switch (input.entity.kind) {
    case "org": {
      await ensureOrgAccess(deps.repos, input.entity.orgId, input.actorHumanId);
      const org = await deps.repos.organizations.getById(input.entity.orgId);
      primaryId = org?.defaultPrimaryPayoutTermsId ?? null;
      resaleId = org?.defaultResalePayoutTermsId ?? null;
      break;
    }
    case "place": {
      await ensurePlaceAccess(
        deps.repos,
        input.entity.placeId,
        input.actorHumanId,
      );
      const place = await deps.repos.places.getById(input.entity.placeId);
      primaryId = place?.defaultPrimaryPayoutTermsId ?? null;
      resaleId = place?.defaultResalePayoutTermsId ?? null;
      break;
    }
    case "human": {
      if (input.actorHumanId !== input.entity.humanId) {
        throw fail("CANNOT_READ_OTHER_HUMAN_DEFAULTS");
      }
      const human = await deps.repos.humans.getById(input.entity.humanId);
      if (!human)
        throw fail("HUMAN_NOT_FOUND");
      primaryId = human.defaultPrimaryPayoutTermsId ?? null;
      resaleId = human.defaultResalePayoutTermsId ?? null;
      break;
    }
  }

  // Hydrate the linked PayoutTerms records in parallel.
  const [primaryPayoutTerms, resalePayoutTerms] = await Promise.all([
    primaryId ? deps.repos.payoutTerms.getById(primaryId) : null,
    resaleId ? deps.repos.payoutTerms.getById(resaleId) : null,
  ]);

  return {
    defaultPrimaryPayoutTermsId: primaryId,
    defaultResalePayoutTermsId: resaleId,
    primaryPayoutTerms: primaryPayoutTerms ?? null,
    resalePayoutTerms: resalePayoutTerms ?? null,
  };
}
