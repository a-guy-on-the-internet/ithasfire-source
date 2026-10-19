import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { VolunteerPackWithRolesRecord } from "@th/ports/repos/volunteering";

import { parseInput } from "../../lib/io";
import { volunteerPackWithRolesSchema } from "../platform/volunteer-packs/schema";
import { ORG_ANY_ROLE, requireOrgMembership } from "../../lib/rbac";
import { listVolunteerPacksInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type ListVolunteerPacksDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

/**
 * Transport-side contract for the organizer picker. Same pack shape the staff
 * reads return, plus the per-request `categoryMatch` ranking flag — the only
 * field this use case adds.
 */
export const listVolunteerPacksOutputSchema = z.array(
  volunteerPackWithRolesSchema.extend({ categoryMatch: z.boolean() }).strict(),
);

/** A pack plus whether it targets the caller's event category. */
export type ListedVolunteerPack = VolunteerPackWithRolesRecord & {
  /**
   * True when `categoryId` was supplied and this pack targets it. Drives the
   * "recommended for your events" affordance in the picker; it is a ranking
   * signal, never a filter — every LIVE pack is returned either way.
   */
  categoryMatch: boolean;
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * The organizer-facing catalogue: every LIVE pack with its catalogue roles
 * and their shift presets, ranked for the picker (FR-013).
 *
 * DRAFT packs are unreachable from here by construction — the repo method is
 * LIVE-only, so unpublished catalogue content cannot leak through this path
 * even if the ranking below changed. Staff preview a DRAFT pack through
 * `getVolunteerPackAdmin`, which gates on STAFF_TECH instead of status
 * (FR-016).
 *
 * Ranking: pinned packs first (`rankFirst`), then packs targeting the
 * caller's category, then curation order, then name. `categoryId` only
 * REORDERS — an org whose category no pack targets still sees the whole
 * catalogue rather than an empty picker.
 *
 * Auth: any org member, matching `listRoleTemplates`. This is catalogue
 * content shared by every org, but membership is still required so the
 * endpoint isn't an unauthenticated read of unreleased curation work.
 */
export async function listVolunteerPacks(
  deps: ListVolunteerPacksDeps,
  rawInput: unknown,
): Promise<ListedVolunteerPack[]> {
  const input = parseInput(listVolunteerPacksInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    await requireOrgMembership({
      repos: tx,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });

    const packs = await tx.volunteering.listLivePacksWithRoles();
    const categoryId = input.categoryId ?? null;

    const ranked = packs.map((pack) => ({
      ...pack,
      categoryMatch:
        categoryId !== null && pack.targetCategoryIds.includes(categoryId),
    }));

    // Stable, total ordering: pinned → category match → curation order →
    // name. The repo already returns (rankFirst, sortOrder, name); re-sorting
    // here is what layers the per-request category signal on top.
    ranked.sort((a, b) => {
      if (a.rankFirst !== b.rankFirst) return a.rankFirst ? -1 : 1;
      if (a.categoryMatch !== b.categoryMatch) return a.categoryMatch ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    });

    return ranked;
  });
}
