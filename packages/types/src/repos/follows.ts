import type { PageOwnerType } from "./entity-pages";

export interface EntityFollowRecord {
  id: string;
  followerHumanId: string;
  entityPageId: string;
  notifyNewEvents: boolean;
  notifyNearby: boolean;
  radiusKm: number | null;
  createdAt: Date;
}

export interface FollowedEntityPageSummary {
  id: string;
  slug: string;
  displayName: string | null;
  avatarUrl: string | null;
  ownerType: PageOwnerType;
  /** Place id for a PLACE page, which lists under `Place.name`. */
  ownerId: string;
}

export interface FollowedEntityRecord extends EntityFollowRecord {
  entityPage: FollowedEntityPageSummary;
}

export interface CursorResult<T> {
  items: T[];
  nextCursor: string | null;
}
