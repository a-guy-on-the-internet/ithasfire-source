import type {
  FeaturedEventRecord,
  FeaturedEventWithEventRecord,
} from "@th/types/repos/featured-events";

export interface FeaturedEventsRepo {
  upsertPlacement(input: {
    eventId: string;
    curatedByHumanId: string;
    curatedAt: Date;
    curatedUntil: Date;
    notes?: string | null;
  }): Promise<FeaturedEventRecord>;

  listActive(input: {
    now: Date;
    limit: number;
    categorySlug?: string | null;
  }): Promise<FeaturedEventWithEventRecord[]>;
}

export type {
  FeaturedEventRecord,
  FeaturedEventWithEventRecord,
} from "@th/types/repos/featured-events";
