import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { featuredItemTypeSchema, publicFeaturedItemSchema } from "./schema";

const sanitizeInternalPath = (value: string | null): string | null => {
  if (!value) return null;
  return /^\/(?!\/)/.test(value) ? value : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const listFeaturedItemsInputSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(20),
    itemType: featuredItemTypeSchema.optional(),
  })
  .strict();

export const listFeaturedItemsOutputSchema = z
  .object({
    items: z.array(publicFeaturedItemSchema),
  })
  .strict();

export type ListFeaturedItemsInput = z.infer<
  typeof listFeaturedItemsInputSchema
>;
export type ListFeaturedItemsOutput = z.infer<
  typeof listFeaturedItemsOutputSchema
>;

export type ListFeaturedItemsDeps = {
  repos: Pick<Repos, "featuredItems" | "events" | "entityPages" | "bans">;
  clock: ClockPort;
  logger?: LoggerPort;
};

async function isPublicFeaturedTarget(
  repos: ListFeaturedItemsDeps["repos"],
  item: {
    itemType: "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";
    itemId: string;
  },
): Promise<boolean> {
  if (item.itemType === "EVENT") {
    const event = await repos.events.getById(item.itemId, {
      withOwnerStanding: true,
    });
    return Boolean(
      event &&
      event.status === "PUBLISHED" &&
      event.visibility === "PUBLIC" &&
      // A banned owner's event is withheld (ban-that-sticks).
      event.ownerBanned !== true &&
      event.slug,
    );
  }

  const pageOwnerType =
    item.itemType === "HUMAN"
      ? "HUMAN"
      : item.itemType === "ORGANIZATION"
        ? "ORGANIZATION"
        : "PLACE";
  const page = await repos.entityPages.getByOwner(pageOwnerType, item.itemId);
  return Boolean(page && page.visibility === "PUBLIC");
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function listFeaturedItems(
  deps: ListFeaturedItemsDeps,
  rawInput: unknown,
): Promise<ListFeaturedItemsOutput> {
  const input = parseInput(listFeaturedItemsInputSchema, rawInput);

  const items = await deps.repos.featuredItems.listActive({
    now: deps.clock.now(),
    limit: input.limit,
    itemType: input.itemType ?? null,
  });

  // Ban that sticks: a featured HUMAN or ORGANIZATION card for a withheld
  // owner (a BANNED human, an org whose every OWNER is banned) drops off the
  // rail. One lookup for the whole rail; derived, so it returns on reactivate.
  const banned = await deps.repos.bans.findBannedOwners({
    humanIds: items.filter((i) => i.itemType === "HUMAN").map((i) => i.itemId),
    orgIds: items
      .filter((i) => i.itemType === "ORGANIZATION")
      .map((i) => i.itemId),
  });
  const withheld = new Set([...banned.humanIds, ...banned.orgIds]);
  const unbannedItems = items.filter(
    (i) =>
      !(
        (i.itemType === "HUMAN" || i.itemType === "ORGANIZATION") &&
        withheld.has(i.itemId)
      ),
  );

  const visibleItems = (
    await Promise.all(
      unbannedItems.map(async (item) =>
        (await isPublicFeaturedTarget(deps.repos, item)) ? item : null,
      ),
    )
  ).filter((item): item is (typeof unbannedItems)[number] => item !== null);

  deps.logger?.info("listFeaturedItems.completed", {
    count: visibleItems.length,
    itemType: input.itemType ?? "all",
  });

  return listFeaturedItemsOutputSchema.parse({
    items: visibleItems.map((item) => ({
      id: item.id,
      itemType: item.itemType,
      itemId: item.itemId,
      title: item.title,
      subtitle: item.subtitle,
      heroImageUrl: sanitizeInternalPath(item.heroImageUrl),
      ctaUrl: sanitizeInternalPath(item.ctaUrl),
      ctaLabel: item.ctaLabel,
      sortOrder: item.sortOrder,
    })),
  });
}
