import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * Public join-page view of an owner's tiers: ACTIVE only, and only the fields
 * a visitor needs to pick one. Stripe ids, tax category and owner internals
 * are deliberately absent from the shape — this feeds an unauthenticated
 * entity page.
 *
 * A suspended standing returns an EMPTY list rather than an error: the
 * circuit breaker exists to stop a bad actor's signups, and a public page has
 * no business distinguishing "no tiers" from "suspended" (that distinction is
 * an oracle on the owner's risk state). `startMembership` re-checks and
 * refuses regardless, so this is presentation, not the enforcement.
 */

export const listPublicTiersInputSchema = z
  .object({
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
  })
  .strict();

export type ListPublicTiersInput = z.infer<typeof listPublicTiersInputSchema>;

const publicTierSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /**
   * The OWNER'S claim about what members get, rendered on the join card and
   * the embed. Owner-authored plain text — never our characterisation of the
   * transaction, and never deductibility language (AB 488).
   */
  benefitsDescription: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  interval: z.enum(["MONTH", "YEAR"]),
  sortOrder: z.number().int(),
});

export const listPublicTiersOutputSchema = z.object({
  items: z.array(publicTierSchema),
});

export type ListPublicTiersOutput = z.infer<typeof listPublicTiersOutputSchema>;

export type ListPublicTiersDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listPublicTiers(
  deps: ListPublicTiersDeps,
  rawInput: unknown,
): Promise<ListPublicTiersOutput> {
  const input = parseInput(listPublicTiersInputSchema, rawInput);

  const ownerOrgId = input.ownerType === "ORGANIZATION" ? input.ownerId : null;
  const ownerHumanId = input.ownerType === "HUMAN" ? input.ownerId : null;

  const standing = await deps.repos.membershipStandings.findForOwner({
    ownerOrgId,
    ownerHumanId,
  });
  if (standing?.suspended) {
    return { items: [] };
  }

  const tiers = await deps.repos.membershipTiers.listForOwner({
    ownerOrgId,
    ownerHumanId,
    statuses: ["ACTIVE"],
  });

  return listPublicTiersOutputSchema.parse({
    items: tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      description: tier.description,
      benefitsDescription: tier.benefitsDescription,
      priceCents: tier.priceCents,
      currency: tier.currency,
      interval: tier.interval,
      sortOrder: tier.sortOrder,
    })),
  });
}
