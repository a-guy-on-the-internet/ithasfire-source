import { describe, expect, it, vi } from "vitest";

import { followEntity } from "../follow-entity";
import { unfollowEntity } from "../unfollow-entity";
import { getEntityFollowerCount } from "../get-entity-follower-count";
import { isFollowing } from "../is-following";

const ACTOR_ID = "human-actor";
const OTHER_HUMAN_PAGE_ID = "page-human-1";
const CREATED_AT = new Date("2026-04-15T00:00:00.000Z");

type FollowRecord = {
  id: string;
  followerHumanId: string;
  entityPageId: string;
  notifyNewEvents: boolean;
  notifyNearby: boolean;
  radiusKm: number | null;
  createdAt: Date;
};

const publicPage = {
  id: OTHER_HUMAN_PAGE_ID,
  ownerType: "HUMAN" as const,
  ownerId: "human-owner",
  slug: "dj-river",
  displayName: "DJ River",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  allowFollows: true,
  showFollowerCount: false,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

function makeDeps(
  overrides?: Partial<{
    page: typeof publicPage | null;
  }>,
) {
  const page = overrides?.page ?? publicPage;
  const follows = new Map<string, FollowRecord>();

  const followsRepo = {
    upsertFollow: vi.fn(
      async (input: {
        followerHumanId: string;
        entityPageId: string;
        notifyNewEvents?: boolean;
        notifyNearby?: boolean;
        radiusKm?: number;
      }) => {
        const key = `${input.followerHumanId}:${input.entityPageId}`;
        const existing = follows.get(key);
        if (existing) {
          return { follow: existing, created: false };
        }

        const created: FollowRecord = {
          id: `follow-${follows.size + 1}`,
          followerHumanId: input.followerHumanId,
          entityPageId: input.entityPageId,
          notifyNewEvents: input.notifyNewEvents ?? true,
          notifyNearby: input.notifyNearby ?? false,
          radiusKm: input.radiusKm ?? null,
          createdAt: CREATED_AT,
        };
        follows.set(key, created);
        return { follow: created, created: true };
      },
    ),
    deleteFollow: vi.fn(
      async (followerHumanId: string, entityPageId: string) => {
        const key = `${followerHumanId}:${entityPageId}`;
        const existing = follows.get(key) ?? null;
        follows.delete(key);
        return {
          deleted: Boolean(existing),
          followId: existing?.id ?? null,
        };
      },
    ),
    getFollow: vi.fn(async (followerHumanId: string, entityPageId: string) => {
      return follows.get(`${followerHumanId}:${entityPageId}`) ?? null;
    }),
    countByEntity: vi.fn(async (entityPageId: string) => {
      return [...follows.values()].filter(
        (entry) => entry.entityPageId === entityPageId,
      ).length;
    }),
    countByEntitySince: vi.fn(async (entityPageId: string, since: Date) => {
      return [...follows.values()].filter(
        (entry) =>
          entry.entityPageId === entityPageId && entry.createdAt >= since,
      ).length;
    }),
    updateFollowPreferences: vi.fn(),
    listByFollower: vi.fn(),
    listByEntity: vi.fn(),
  };

  const entityPagesRepo = {
    getById: vi.fn(async (id: string) => (page?.id === id ? page : null)),
    updateFollowSettings: vi.fn(
      async (
        entityPageId: string,
        data: { allowFollows: boolean; showFollowerCount: boolean },
      ) => ({
        ...(page ?? publicPage),
        id: entityPageId,
        ...data,
      }),
    ),
  };

  const authz = {
    requireOrgRole: vi.fn(async () => undefined),
    canManagePlace: vi.fn(async () => ({ allowed: true })),
    hasStaffRole: vi.fn(async () => ({ allowed: false })),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const txRepos = {
    follows: followsRepo,
    entityPages: entityPagesRepo,
    audit: auditRepo,
  };

  return {
    deps: {
      repos: {
        follows: followsRepo,
        entityPages: entityPagesRepo,
        audit: auditRepo,
        authz,
        tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
          fn(txRepos),
        ),
      },
      authz,
    } as any,
    follows,
    followsRepo,
    entityPagesRepo,
    authz,
  };
}

describe("follows slice", () => {
  it("returns an idempotent result when following the same entity twice", async () => {
    const { deps, followsRepo } = makeDeps();

    const first = await followEntity(deps, {
      actorHumanId: ACTOR_ID,
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    const second = await followEntity(deps, {
      actorHumanId: ACTOR_ID,
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    expect(first.alreadyFollowing).toBe(false);
    expect(second.alreadyFollowing).toBe(true);
    expect(second.followId).toBe(first.followId);
    expect(followsRepo.upsertFollow).toHaveBeenCalledTimes(2);
  });

  it("blocks self-follow for HUMAN pages", async () => {
    const { deps } = makeDeps({
      page: {
        ...publicPage,
        ownerId: ACTOR_ID,
      },
    });

    await expect(
      followEntity(deps, {
        actorHumanId: ACTOR_ID,
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).rejects.toMatchObject({ code: "SELF_FOLLOW_NOT_ALLOWED" });
  });

  it("blocks follows when the entity disables them", async () => {
    const { deps } = makeDeps({
      page: {
        ...publicPage,
        allowFollows: false,
      },
    });

    await expect(
      followEntity(deps, {
        actorHumanId: ACTOR_ID,
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).rejects.toMatchObject({ code: "FOLLOWS_DISABLED" });
  });

  it("unfollow is idempotent even when no follow exists", async () => {
    const { deps } = makeDeps();

    await expect(
      unfollowEntity(deps, {
        actorHumanId: ACTOR_ID,
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).resolves.toEqual({ success: true });
  });

  it("withholds the raw count when follower counts are hidden", async () => {
    const { deps } = makeDeps({
      page: {
        ...publicPage,
        showFollowerCount: false,
      },
    });

    await followEntity(deps, {
      actorHumanId: ACTOR_ID,
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    const result = await getEntityFollowerCount(deps, {
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    expect(result).toEqual({ count: 0, isPublic: false });
  });

  it("returns the exact count when follower counts are public", async () => {
    const { deps } = makeDeps({
      page: {
        ...publicPage,
        showFollowerCount: true,
      },
    });

    await followEntity(deps, {
      actorHumanId: ACTOR_ID,
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    const result = await getEntityFollowerCount(deps, {
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    expect(result).toEqual({ count: 1, isPublic: true });
  });

  it("does not expose follower counts for private pages", async () => {
    const { deps } = makeDeps({
      page: {
        ...publicPage,
        visibility: "PRIVATE",
      },
    });

    await expect(
      getEntityFollowerCount(deps, {
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
  });

  it("reports following status for the actor", async () => {
    const { deps } = makeDeps();

    expect(
      await isFollowing(deps, {
        actorHumanId: ACTOR_ID,
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).toEqual({ isFollowing: false });

    await followEntity(deps, {
      actorHumanId: ACTOR_ID,
      entityPageId: OTHER_HUMAN_PAGE_ID,
    });

    expect(
      await isFollowing(deps, {
        actorHumanId: ACTOR_ID,
        entityPageId: OTHER_HUMAN_PAGE_ID,
      }),
    ).toEqual({ isFollowing: true });
  });
});
