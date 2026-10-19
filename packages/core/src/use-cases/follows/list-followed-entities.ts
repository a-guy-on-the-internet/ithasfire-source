import { z } from "zod";

import { parseInput } from "../../lib/io";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { resolveVisibleImageKeys } from "../moderation/gate-image-visibility";
import { getEntityPageImageKeyPrefix } from "../entity-pages/page-image-upload-helpers";
import { pageImageKeysMentionedIn } from "../entity-pages/page-image-urls";
import {
  listFollowedEntitiesInputSchema,
  listFollowedEntitiesOutputSchema,
} from "./schemas";

export type ListFollowedEntitiesInput = z.infer<
  typeof listFollowedEntitiesInputSchema
>;
export type ListFollowedEntitiesOutput = z.infer<
  typeof listFollowedEntitiesOutputSchema
>;

export type ListFollowedEntitiesDeps = {
  /**
   * `imageModerationRecords`: a place page's avatar that the image review
   * has not approved is left out (see `hiddenPlaceAvatars`).
   */
  repos: Pick<Repos, "follows" | "places" | "imageModerationRecords">;
  logger?: LoggerPort;
};

export async function listFollowedEntities(
  deps: ListFollowedEntitiesDeps,
  rawInput: unknown,
): Promise<ListFollowedEntitiesOutput> {
  const logger = deps.logger?.child({ useCase: "listFollowedEntities" });

  const execute = async () => {
    const input = parseInput(listFollowedEntitiesInputSchema, rawInput);
    const result = await deps.repos.follows.listByFollower(input.actorHumanId, {
      ownerTypeFilter: input.ownerTypeFilter,
      cursor: input.cursor,
      limit: input.limit,
    });

    // One name per place: a PLACE page lists as `Place.name`; the page's
    // displayName is frozen for places and never read. One batched read.
    const placeIds = [
      ...new Set(
        result.items
          .filter((item) => item.entityPage.ownerType === "PLACE")
          .map((item) => item.entityPage.ownerId),
      ),
    ];
    const places =
      placeIds.length > 0
        ? await deps.repos.places.getByIds(placeIds)
        : new Map<string, { name: string }>();
    const hiddenAvatars = await hiddenPlaceAvatars(deps.repos, result.items);

    return listFollowedEntitiesOutputSchema.parse({
      items: result.items.map((item) => ({
        followId: item.id,
        entityPageId: item.entityPage.id,
        slug: item.entityPage.slug,
        displayName:
          item.entityPage.ownerType === "PLACE"
            ? (places.get(item.entityPage.ownerId)?.name ?? item.entityPage.slug)
            : (item.entityPage.displayName ?? item.entityPage.slug),
        avatarUrl: hiddenAvatars.has(item.entityPage.id)
          ? null
          : item.entityPage.avatarUrl,
        ownerType: item.entityPage.ownerType,
        followedAt: item.createdAt,
        notifyNewEvents: item.notifyNewEvents,
        notifyNearby: item.notifyNearby,
        radiusKm: item.radiusKm,
      })),
      nextCursor: result.nextCursor,
    });
  };

  if (logger) {
    return logger.withTime("listFollowedEntities", execute);
  }

  return execute();
}

/**
 * The ids of the followed PLACE pages whose avatar the image review has not
 * approved (a community moderator's upload still PENDING, or FLAGGED /
 * REJECTED), so the list shows no avatar for them, as the public page does
 * (gate-page-images.ts). Only place pages can hold a reviewed image. One
 * batched lookup for the whole list, none when no place avatar is an upload.
 */
async function hiddenPlaceAvatars(
  repos: Pick<Repos, "imageModerationRecords">,
  items: readonly {
    entityPage: { id: string; ownerType: string; ownerId: string; avatarUrl: string | null };
  }[],
): Promise<Set<string>> {
  const keysByPage = new Map<string, string[]>();
  for (const { entityPage } of items) {
    if (entityPage.ownerType !== "PLACE" || entityPage.avatarUrl === null) continue;
    const keys = pageImageKeysMentionedIn(
      [entityPage.avatarUrl],
      getEntityPageImageKeyPrefix("PLACE", entityPage.ownerId),
    );
    if (keys.length > 0) keysByPage.set(entityPage.id, keys);
  }
  if (keysByPage.size === 0) return new Set();
  const visible = await resolveVisibleImageKeys(
    repos,
    [...keysByPage.values()].flat(),
  );
  const hidden = new Set<string>();
  for (const [pageId, keys] of keysByPage) {
    if (keys.some((key) => !visible.has(key))) hidden.add(pageId);
  }
  return hidden;
}
