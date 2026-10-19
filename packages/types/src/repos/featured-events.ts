import type { EventRecord } from "./events";

export interface FeaturedEventRecord {
  id: string;
  eventId: string;
  curatedByHumanId: string | null;
  curatedAt: Date;
  curatedUntil: Date | null;
  notes: string | null;
}

export interface FeatureEventInput {
  eventId: string;
  curatedByHumanId: string;
  curatedUntil: Date;
  notes?: string | null;
}

export interface FeaturedEventWithEventRecord {
  featured: FeaturedEventRecord;
  event: EventRecord;
}
