import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import type { AuthZPort } from "@th/ports/authz";

import { parseInput } from "../../../lib/io";
import {
  plainTextMultilineOptional,
  plainTextOptional,
} from "../../../lib/sanitize-plain-text";
import { requirePlatformStaff } from "../../../lib/rbac";
import { fail } from "@th/errors";
import {
  featuredItemRecordSchema,
  featuredItemTypeSchema,
  internalPathSchema,
} from "./schema";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const upsertFeaturedItemInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    itemType: featuredItemTypeSchema,
    itemId: z.string().uuid(),
    title: plainTextOptional(200).optional(),
    subtitle: plainTextOptional(500).optional(),
    heroImageUrl: internalPathSchema.optional(),
    ctaUrl: internalPathSchema.optional(),
    ctaLabel: plainTextOptional(100).optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
    curatedUntil: z.coerce.date().optional(),
    notes: plainTextMultilineOptional(2000).optional(),
  })
  .strict();

export const upsertFeaturedItemOutputSchema = z
  .object({
    item: featuredItemRecordSchema,
  })
  .strict();

export type UpsertFeaturedItemInput = z.infer<
  typeof upsertFeaturedItemInputSchema
>;
export type UpsertFeaturedItemOutput = z.infer<
  typeof upsertFeaturedItemOutputSchema
>;

export type UpsertFeaturedItemDeps = {
  repos: Pick<
    Repos,
    | "featuredItems"
    | "audit"
    | "tx"
    | "events"
    | "humans"
    | "organizations"
    | "places"
    | "entityPages"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

async function assertFeaturedTargetIsPublic(
  repos: UpsertFeaturedItemDeps["repos"],
  input: Pick<UpsertFeaturedItemInput, "itemType" | "itemId">,
): Promise<void> {
  switch (input.itemType) {
    case "EVENT": {
      const event = await repos.events.getById(input.itemId);
      if (!event) {
        throw fail("FEATURED_ITEM_TARGET_NOT_FOUND");
      }
      if (
        event.status !== "PUBLISHED" ||
        event.visibility !== "PUBLIC" ||
        !event.slug
      ) {
        throw fail("FEATURED_ITEM_TARGET_NOT_PUBLIC");
      }
      return;
    }
    case "HUMAN": {
      const human = await repos.humans.getById(input.itemId);
      if (!human) {
        throw fail("FEATURED_ITEM_TARGET_NOT_FOUND");
      }
      const page = await repos.entityPages.getByOwner("HUMAN", input.itemId);
      if (human.status !== "ACTIVE" || !page || page.visibility !== "PUBLIC") {
        throw fail("FEATURED_ITEM_TARGET_NOT_PUBLIC");
      }
      return;
    }
    case "ORGANIZATION": {
      const organization = await repos.organizations.getById(input.itemId);
      if (!organization) {
        throw fail("FEATURED_ITEM_TARGET_NOT_FOUND");
      }
      const page = await repos.entityPages.getByOwner(
        "ORGANIZATION",
        input.itemId,
      );
      if (
        organization.status !== "ACTIVE" ||
        !organization.slug ||
        !page ||
        page.visibility !== "PUBLIC"
      ) {
        throw fail("FEATURED_ITEM_TARGET_NOT_PUBLIC");
      }
      return;
    }
    case "PLACE": {
      const place = await repos.places.getById(input.itemId);
      if (!place) {
        throw fail("FEATURED_ITEM_TARGET_NOT_FOUND");
      }
      const page = await repos.entityPages.getByOwner("PLACE", input.itemId);
      // A PUBLIC EntityPage IS the linkability check: `/places/[slug]` and
      // `/p/[slug]` resolve `page.slug`, so a place with a public page is
      // always reachable. (This used to additionally require `place.slug`.
      // That was the deprecated multi-segment directory key no route ever
      // resolved — keeping the check would now reject every venue, since
      // nothing mints it any more.)
      if (
        place.status !== "ACTIVE" ||
        !place.listedInDirectory ||
        !page ||
        page.visibility !== "PUBLIC"
      ) {
        throw fail("FEATURED_ITEM_TARGET_NOT_PUBLIC");
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertFeaturedItem(
  deps: UpsertFeaturedItemDeps,
  rawInput: unknown,
): Promise<UpsertFeaturedItemOutput> {
  const input = parseInput(upsertFeaturedItemInputSchema, rawInput);

  await requirePlatformStaff({
    authz: deps.authz,
    actorHumanId: input.actorHumanId,
    roles: ["ADMIN", "REVIEWER", "SUPPORT", "DEVELOPER"],
  });

  await assertFeaturedTargetIsPublic(deps.repos, input);

  const item = await deps.repos.tx(async (tx) => {
    const result = await tx.featuredItems.upsert({
      itemType: input.itemType,
      itemId: input.itemId,
      title: input.title,
      subtitle: input.subtitle,
      heroImageUrl: input.heroImageUrl,
      ctaUrl: input.ctaUrl,
      ctaLabel: input.ctaLabel,
      sortOrder: input.sortOrder,
      active: input.active,
      curatedByHumanId: input.actorHumanId,
      curatedAt: deps.clock.now(),
      curatedUntil: input.curatedUntil,
      notes: input.notes,
    });

    await tx.audit.log({
      entity: "FeaturedItem",
      entityId: result.id,
      action: "featured_item.upsert",
      data: {
        actorHumanId: input.actorHumanId,
        itemType: input.itemType,
        itemId: input.itemId,
      },
    });

    return result;
  });

  deps.logger?.info("upsertFeaturedItem.completed", {
    itemId: item.id,
    itemType: input.itemType,
    targetId: input.itemId,
  });

  return upsertFeaturedItemOutputSchema.parse({ item });
}
