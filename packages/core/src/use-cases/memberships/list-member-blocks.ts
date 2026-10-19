import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { normalizeBlockSection } from "../entity-pages/block-sections";
import { MEMBERSHIP_BENEFIT_GRANTING_STATUSES } from "./membership-status";

/**
 * Member-gated page blocks (`section == "memberships"`) for an owner's
 * entity page.
 *
 * WHY THIS EXISTS: `getPublicPage` UNCONDITIONALLY drops non-"main" sections —
 * its output is the public, anonymously-cacheable payload (ISR HTML + RSC
 * flight on /p/[slug]), so member-only content must never enter it. This use
 * case is the ONLY read path for those blocks, and it verifies the caller's
 * membership IN CORE before touching them.
 *
 * The gate mirrors the Membership-tab UI rule: the caller must hold a
 * membership in a BENEFIT-GRANTING status (`active`/`trialing` — a past_due
 * card earns nothing) on a tier owned by THIS owner. A membership at a
 * different owner unlocks nothing here.
 *
 * A non-member gets an EMPTY list, never an error: the Membership tab treats
 * "no blocks" as "pitch only", and an error would break the tab for everyone
 * signed in without a membership.
 *
 * Blocks are returned as stored (visible, memberships-section, repo order) —
 * the server-built derivations in getPublicPage (shows/stats/announcements…)
 * are main-section, public-page concepts and deliberately do not run here.
 */

export const listMemberBlocksInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** PLACEs cannot own membership tiers, so they have no member section. */
    ownerType: z.enum(["HUMAN", "ORGANIZATION"]),
    ownerId: z.string().uuid(),
  })
  .strict();

export type ListMemberBlocksInput = z.infer<typeof listMemberBlocksInputSchema>;

export const listMemberBlocksOutputSchema = z
  .object({
    /** Same record shape the public page's BlockRenderer consumes. */
    blocks: z.array(
      z.object({
        id: z.string(),
        pageId: z.string(),
        kind: z.string(),
        orderIndex: z.number(),
        data: z.unknown(),
        visible: z.boolean(),
        section: z.string().default("main"),
      }),
    ),
  })
  .strict();

export type ListMemberBlocksOutput = z.infer<typeof listMemberBlocksOutputSchema>;

export type ListMemberBlocksDeps = {
  repos: Pick<Repos, "memberships" | "membershipTiers" | "entityPages">;
  logger?: LoggerPort;
};

export async function listMemberBlocks(
  deps: ListMemberBlocksDeps,
  rawInput: unknown,
): Promise<ListMemberBlocksOutput> {
  const input = parseInput(listMemberBlocksInputSchema, rawInput);

  // 1. The caller's benefit-granting memberships. Statuses are filtered at
  //    the repo so a past_due/canceled row never even reaches the owner check.
  const memberships = await deps.repos.memberships.listForMember({
    memberHumanId: input.actorHumanId,
    statuses: [...MEMBERSHIP_BENEFIT_GRANTING_STATUSES],
  });
  if (memberships.length === 0) {
    return { blocks: [] };
  }

  // 2. Does any of those memberships sit on a tier owned by THIS owner?
  //    (Archived tiers still count — a member's standing survives the catalog
  //    changing underneath them, same rule as the Membership tab.)
  const tierIds = Array.from(new Set(memberships.map((m) => m.tierId)));
  const tiers = await Promise.all(
    tierIds.map((id) => deps.repos.membershipTiers.findById(id)),
  );
  const isMember = tiers.some(
    (tier) =>
      tier != null &&
      (input.ownerType === "ORGANIZATION"
        ? tier.ownerOrgId === input.ownerId
        : tier.ownerHumanId === input.ownerId),
  );
  if (!isMember) {
    return { blocks: [] };
  }

  // 3. Only now touch the page content. No page (or a PRIVATE one — never
  //    served publicly, so its member tab does not exist either) → empty.
  const page = await deps.repos.entityPages.getByOwner(
    input.ownerType,
    input.ownerId,
  );
  if (!page || page.visibility === "PRIVATE") {
    return { blocks: [] };
  }

  const blocks = await deps.repos.entityPages.listBlocks(page.id);
  const memberBlocks = blocks.filter(
    (block) =>
      block.visible && normalizeBlockSection(block.section) === "memberships",
  );

  return listMemberBlocksOutputSchema.parse({ blocks: memberBlocks });
}
