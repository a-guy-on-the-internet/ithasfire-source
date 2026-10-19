import type { TagRecord, EventTagWithTag } from "@th/types/repos/tags";

export interface TagsRepo {
  /** Find a tag by slug. */
  getBySlug(slug: string): Promise<TagRecord | null>;

  /** Find or create a tag. Returns the existing or newly created record. */
  findOrCreate(input: { slug: string; name: string }): Promise<TagRecord>;

  /** Search tags by prefix. Used for autocomplete. */
  search(query: string, opts?: { limit?: number }): Promise<TagRecord[]>;

  /** Replace all tags on an event (full sync). Deletes old join rows, inserts new ones. */
  setEventTags(
    eventId: string,
    tags: Array<{ slug: string; name: string; sortOrder: number }>,
  ): Promise<EventTagWithTag[]>;

  /** Get all tags for an event, ordered by sortOrder. */
  getEventTags(eventId: string): Promise<EventTagWithTag[]>;
}

export type { TagRecord, EventTagWithTag };
