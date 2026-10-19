import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * The member's own memberships, shaped for the account page: every status
 * (a canceled membership is history the member should still see), joined
 * with the tier's display fields and the owner's display name.
 *
 * Caller identity IS the filter — the actor can only ever list their own
 * rows, so there is no authz beyond authentication. Stripe ids and billing
 * address fields never leave core.
 *
 * No pagination: a human's membership count is bounded by how many venues
 * they support, not by data volume. MAX_ITEMS is a hard backstop, newest
 * first, so a pathological account cannot balloon the payload.
 */

const MAX_ITEMS = 100;

export const listMyMembershipsInputSchema = z
  .object({ actorHumanId: z.string().uuid() })
  .strict();

export type ListMyMembershipsInput = z.infer<typeof listMyMembershipsInputSchema>;

const myMembershipSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  cancelAtPeriodEnd: z.boolean(),
  canceledAt: z.coerce.date().nullable(),
  currentPeriodEnd: z.coerce.date(),
  startedAt: z.coerce.date(),
  tier: z.object({
    id: z.string().uuid(),
    name: z.string(),
    priceCents: z.number().int(),
    currency: z.string(),
    interval: z.enum(["MONTH", "YEAR"]),
  }),
  owner: z.object({
    type: z.enum(["HUMAN", "ORGANIZATION"]),
    id: z.string().uuid(),
    name: z.string().nullable(),
  }),
});

export const listMyMembershipsOutputSchema = z.object({
  items: z.array(myMembershipSchema),
});

export type ListMyMembershipsOutput = z.infer<
  typeof listMyMembershipsOutputSchema
>;

export type ListMyMembershipsDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function listMyMemberships(
  deps: ListMyMembershipsDeps,
  rawInput: unknown,
): Promise<ListMyMembershipsOutput> {
  const input = parseInput(listMyMembershipsInputSchema, rawInput);

  const memberships = await deps.repos.memberships.listForMember({
    memberHumanId: input.actorHumanId,
  });
  if (memberships.length === 0) {
    return { items: [] };
  }

  const sorted = [...memberships]
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, MAX_ITEMS);

  const tierIds = Array.from(new Set(sorted.map((m) => m.tierId)));
  const tiers = await Promise.all(
    tierIds.map((id) => deps.repos.membershipTiers.findById(id)),
  );
  const tiersById = new Map(
    tiers.flatMap((tier) => (tier ? [[tier.id, tier] as const] : [])),
  );

  const orgIds = new Set<string>();
  const humanIds = new Set<string>();
  for (const tier of tiersById.values()) {
    if (tier.ownerOrgId) orgIds.add(tier.ownerOrgId);
    else if (tier.ownerHumanId) humanIds.add(tier.ownerHumanId);
  }

  const [orgs, humans] = await Promise.all([
    orgIds.size > 0
      ? deps.repos.organizations.getByIds(Array.from(orgIds))
      : Promise.resolve([]),
    humanIds.size > 0
      ? deps.repos.humans.getByIds(Array.from(humanIds))
      : Promise.resolve([]),
  ]);
  const orgNames = new Map(orgs.map((org) => [org.id, org.name]));
  const humanNames = new Map(humans.map((human) => [human.id, human.name]));

  const items = sorted.flatMap((membership) => {
    const tier = tiersById.get(membership.tierId);
    // A membership whose tier row is gone is a broken FK we should never see
    // (tiers are archived, not deleted); skip rather than 500 the whole page.
    if (!tier) {
      deps.logger?.error("membership.list_mine.tier_missing", {
        membershipId: membership.id,
        tierId: membership.tierId,
      });
      return [];
    }
    const owner = tier.ownerOrgId
      ? {
          type: "ORGANIZATION" as const,
          id: tier.ownerOrgId,
          name: orgNames.get(tier.ownerOrgId) ?? null,
        }
      : {
          type: "HUMAN" as const,
          id: tier.ownerHumanId!,
          name: humanNames.get(tier.ownerHumanId!) ?? null,
        };
    return [
      {
        id: membership.id,
        status: membership.status,
        cancelAtPeriodEnd: membership.cancelAtPeriodEnd,
        canceledAt: membership.canceledAt,
        currentPeriodEnd: membership.currentPeriodEnd,
        startedAt: membership.startedAt,
        tier: {
          id: tier.id,
          name: tier.name,
          priceCents: tier.priceCents,
          currency: tier.currency,
          interval: tier.interval,
        },
        owner,
      },
    ];
  });

  return listMyMembershipsOutputSchema.parse({ items });
}
