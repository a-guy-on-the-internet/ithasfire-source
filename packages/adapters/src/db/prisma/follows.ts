import { Prisma } from "@prisma/client";
import type { FollowsRepo } from "@th/ports/repos/follows";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const followSelect = {
  id: true,
  followerHumanId: true,
  entityPageId: true,
  notifyNewEvents: true,
  notifyNearby: true,
  radiusKm: true,
  createdAt: true,
} as const;

const followedEntityPageSelect = {
  id: true,
  slug: true,
  displayName: true,
  avatarUrl: true,
  ownerType: true,
  ownerId: true,
} as const;

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeFollowsRepo(p: PrismaClientOrTx): FollowsRepo {
  return {
    upsertFollow: async (data) => {
      try {
        const follow = await p.entityFollow.create({
          data: {
            followerHumanId: data.followerHumanId,
            entityPageId: data.entityPageId,
            notifyNewEvents: data.notifyNewEvents ?? true,
            notifyNearby: data.notifyNearby ?? false,
            radiusKm:
              data.notifyNearby === false ? null : (data.radiusKm ?? null),
          },
          select: followSelect,
        });

        return { follow, created: true };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const follow = await p.entityFollow.findUnique({
            where: {
              followerHumanId_entityPageId: {
                followerHumanId: data.followerHumanId,
                entityPageId: data.entityPageId,
              },
            },
            select: followSelect,
          });

          if (!follow) {
            throw error;
          }

          return { follow, created: false };
        }

        throw error;
      }
    },

    deleteFollow: async (followerHumanId: string, entityPageId: string) => {
      const existing = await p.entityFollow.findUnique({
        where: {
          followerHumanId_entityPageId: {
            followerHumanId,
            entityPageId,
          },
        },
        select: followSelect,
      });

      if (!existing) {
        return { deleted: false, followId: null };
      }

      const result = await p.entityFollow.deleteMany({
        where: { followerHumanId, entityPageId },
      });

      return {
        deleted: result.count > 0,
        followId: result.count > 0 ? existing.id : null,
      };
    },

    getFollow: (followerHumanId: string, entityPageId: string) =>
      p.entityFollow.findUnique({
        where: {
          followerHumanId_entityPageId: {
            followerHumanId,
            entityPageId,
          },
        },
        select: followSelect,
      }),

    listByFollower: async (followerHumanId: string, opts) => {
      const limit = getSafeLimit(opts?.limit);
      const rows = await p.entityFollow.findMany({
        where: {
          followerHumanId,
          ...(opts?.ownerTypeFilter
            ? { entityPage: { ownerType: opts.ownerTypeFilter } }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(opts?.cursor
          ? {
              cursor: { id: opts.cursor },
              skip: 1,
            }
          : {}),
        take: limit + 1,
        select: {
          ...followSelect,
          entityPage: { select: followedEntityPageSelect },
        },
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    listByEntity: async (entityPageId: string, opts) => {
      const limit = getSafeLimit(opts?.limit);
      const rows = await p.entityFollow.findMany({
        where: { entityPageId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(opts?.cursor
          ? {
              cursor: { id: opts.cursor },
              skip: 1,
            }
          : {}),
        take: limit + 1,
        select: followSelect,
      });

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    countByEntity: (entityPageId: string) =>
      p.entityFollow.count({
        where: { entityPageId },
      }),

    countByEntitySince: (entityPageId: string, since: Date) =>
      p.entityFollow.count({
        where: {
          entityPageId,
          createdAt: { gte: since },
        },
      }),

    listFollowersNearLocation: (entityPageId: string, _location, opts) =>
      p.entityFollow.findMany({
        where: {
          entityPageId,
          notifyNearby: true,
          radiusKm: { not: null },
        },
        take: Math.min(
          Math.max(opts?.batchSize ?? DEFAULT_LIMIT, 1),
          MAX_LIMIT,
        ),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: followSelect,
      }),

    updateFollowPreferences: (
      followerHumanId: string,
      entityPageId: string,
      prefs,
    ) =>
      p.entityFollow.update({
        where: {
          followerHumanId_entityPageId: {
            followerHumanId,
            entityPageId,
          },
        },
        data: {
          notifyNewEvents: prefs.notifyNewEvents,
          notifyNearby: prefs.notifyNearby,
          radiusKm: prefs.notifyNearby ? (prefs.radiusKm ?? null) : null,
        },
        select: followSelect,
      }),
  };
}
