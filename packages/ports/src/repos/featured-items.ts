import type {
  FeaturedItemRecord,
  FeaturedItemType,
} from "@th/types/repos/featured-items";

export interface FeaturedItemsRepo {
  upsert(input: {
    itemType: FeaturedItemType;
    itemId: string;
    title?: string | null;
    subtitle?: string | null;
    heroImageUrl?: string | null;
    ctaUrl?: string | null;
    ctaLabel?: string | null;
    sortOrder?: number;
    active?: boolean;
    curatedByHumanId: string;
    curatedAt: Date;
    curatedUntil?: Date | null;
    notes?: string | null;
  }): Promise<FeaturedItemRecord>;

  remove(input: { itemType: FeaturedItemType; itemId: string }): Promise<void>;

  listActive(input: {
    now: Date;
    limit: number;
    itemType?: FeaturedItemType | null;
  }): Promise<FeaturedItemRecord[]>;

  listAll(input: {
    limit: number;
    offset: number;
  }): Promise<{ items: FeaturedItemRecord[]; total: number }>;

  findByTypeAndId(input: {
    itemType: FeaturedItemType;
    itemId: string;
  }): Promise<FeaturedItemRecord | null>;
}

export type {
  FeaturedItemRecord,
  FeaturedItemType,
} from "@th/types/repos/featured-items";
