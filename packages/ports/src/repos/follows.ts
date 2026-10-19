import type { PageOwnerType } from "@th/types/repos/entity-pages";
import type {
  CursorResult,
  EntityFollowRecord,
  FollowedEntityRecord,
  FollowedEntityPageSummary,
} from "@th/types/repos/follows";

export interface FollowsRepo {
  upsertFollow(data: {
    followerHumanId: string;
    entityPageId: string;
    notifyNewEvents?: boolean;
    notifyNearby?: boolean;
    radiusKm?: number;
  }): Promise<{ follow: EntityFollowRecord; created: boolean }>;

  deleteFollow(
    followerHumanId: string,
    entityPageId: string,
  ): Promise<{ deleted: boolean; followId: string | null }>;

  getFollow(
    followerHumanId: string,
    entityPageId: string,
  ): Promise<EntityFollowRecord | null>;

  listByFollower(
    followerHumanId: string,
    opts?: {
      ownerTypeFilter?: PageOwnerType;
      cursor?: string | null;
      limit?: number;
    },
  ): Promise<CursorResult<FollowedEntityRecord>>;

  listByEntity(
    entityPageId: string,
    opts?: { cursor?: string | null; limit?: number },
  ): Promise<CursorResult<EntityFollowRecord>>;

  countByEntity(entityPageId: string): Promise<number>;

  countByEntitySince(entityPageId: string, since: Date): Promise<number>;

  listFollowersNearLocation(
    entityPageId: string,
    location: { lat: number; lng: number },
    opts?: { batchSize?: number },
  ): Promise<EntityFollowRecord[]>;

  updateFollowPreferences(
    followerHumanId: string,
    entityPageId: string,
    prefs: {
      notifyNewEvents: boolean;
      notifyNearby: boolean;
      radiusKm?: number;
    },
  ): Promise<EntityFollowRecord>;
}

export type {
  CursorResult,
  EntityFollowRecord,
  FollowedEntityRecord,
  FollowedEntityPageSummary,
  PageOwnerType,
};
