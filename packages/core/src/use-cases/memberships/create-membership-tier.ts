import { z } from "zod";

import { fail } from "@th/errors";
import type { Repos } from "@th/ports/repos";
import type { MembershipTierRecord } from "@th/ports/repos/membership-tiers";

import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import { requireOwnerAccess, ORG_FINANCE_ROLES } from "../../lib/rbac";

/**
 * Create a membership tier as a DRAFT.
 *
 * No Stripe objects are minted here. A draft is an editable idea; Stripe
 * Products and Prices are created at publish, because Prices are IMMUTABLE and
 * minting one per keystroke of an unfinished draft would litter the account
 * with orphans that can never be cleaned up properly.
 */

/**
 * Base object shape, exported for the transport's `.omit({ actorHumanId })` —
 * the XOR refine below turns the schema into a ZodEffects, which cannot be
 * omitted from. The use case always parses the REFINED schema, so the XOR is
 * enforced regardless of which shape the boundary validated.
 */
export const createMembershipTierInputSchemaBase = z
  .object({
    actorHumanId: z.string().uuid(),
    ownerOrgId: z.string().uuid().nullable().optional(),
    ownerHumanId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    /**
     * The owner's own statement of what members get. Not a tax judgment and
     * not a deductibility claim — a membership is not a donation (AB 488) and
     * nothing in this system may characterise it as one.
     */
    benefitsDescription: plainTextMultilineOptional(500).nullable().optional(),
    priceCents: z.number().int().positive().max(100_000_00),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toLowerCase()),
    interval: z.enum(["MONTH", "YEAR"]).default("MONTH"),
    sortOrder: z.number().int().min(0).max(9_999).optional(),
  })
  .strict();

export const createMembershipTierInputSchema = createMembershipTierInputSchemaBase
  // Prisma cannot express a XOR across two nullable FKs, so the constraint is
  // enforced here. Both-set would make ownership ambiguous at payout time;
  // neither-set would orphan the tier.
  .refine(
    (value) => !!value.ownerOrgId !== !!value.ownerHumanId,
    "Exactly one of ownerOrgId / ownerHumanId must be set",
  );

export type CreateMembershipTierInput = z.infer<
  typeof createMembershipTierInputSchema
>;

export type CreateMembershipTierDeps = { repos: Repos };

export async function createMembershipTier(
  deps: CreateMembershipTierDeps,
  rawInput: unknown,
): Promise<MembershipTierRecord> {
  const input = parseInput(createMembershipTierInputSchema, rawInput);

  // ── RBAC ──────────────────────────────────────────────────────────────
  // Finance roles, matching promos: a tier is a recurring price the owner
  // charges, so creating one is a money action.
  await requireOwnerAccess({
    repos: deps.repos,
    ownerType: input.ownerOrgId ? "ORGANIZATION" : "HUMAN",
    ownerId: input.ownerOrgId ?? input.ownerHumanId!,
    actorHumanId: input.actorHumanId,
    roles: ORG_FINANCE_ROLES,
  });

  // Memberships are open to any payee — there is no ticket-volume gate, since
  // the $2 Connect fee is recovered from the payout itself. The only thing
  // that blocks a tier is a suspended standing.
  await assertNotSuspended(deps.repos, input);

  return deps.repos.membershipTiers.create({
    ownerOrgId: input.ownerOrgId ?? null,
    ownerHumanId: input.ownerHumanId ?? null,
    name: input.name,
    description: input.description ?? null,
    benefitsDescription: input.benefitsDescription ?? null,
    priceCents: input.priceCents,
    currency: input.currency,
    interval: input.interval,
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  });
}

async function assertNotSuspended(
  repos: Repos,
  input: { ownerOrgId?: string | null; ownerHumanId?: string | null },
): Promise<void> {
  const standing = await repos.membershipStandings.findForOwner({
    ownerOrgId: input.ownerOrgId ?? null,
    ownerHumanId: input.ownerHumanId ?? null,
  });
  if (standing?.suspended) {
    throw fail("MEMBERSHIPS_SUSPENDED", {
      meta: {
        ownerOrgId: input.ownerOrgId ?? null,
        ownerHumanId: input.ownerHumanId ?? null,
      },
    });
  }
}
