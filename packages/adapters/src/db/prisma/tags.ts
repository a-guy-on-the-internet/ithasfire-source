import type { TagsRepo } from "@th/ports/repos/tags";
import type { TagRecord, EventTagWithTag } from "@th/types/repos/tags";

import type { PrismaClientOrTx } from "./types";

const TAG_SELECT = {
  id: true,
  slug: true,
  name: true,
  createdAt: true,
} as const;

const mapTag = (row: {
  id: string;
  slug: string;
  name: string;
  createdAt: Date;
}): TagRecord => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  createdAt: row.createdAt,
});

export function makeTagsRepo(p: PrismaClientOrTx): TagsRepo {
  return {
    async getBySlug(slug) {
      const row = await p.tag.findUnique({
        where: { slug },
        select: TAG_SELECT,
      });
      return row ? mapTag(row) : null;
    },

    async findOrCreate({ slug, name }) {
      // Upsert: create if not exists, otherwise return the existing record.
      const row = await p.tag.upsert({
        where: { slug },
        create: { slug, name },
        update: {}, // no-op on existing
        select: TAG_SELECT,
      });
      return mapTag(row);
    },

    async search(query, opts) {
      const limit = Math.min(opts?.limit ?? 20, 50);
      const trimmed = query.trim().toLowerCase();
      if (!trimmed) return [];

      const rows = await p.tag.findMany({
        where: {
          OR: [
            { slug: { startsWith: trimmed } },
            { name: { startsWith: trimmed, mode: "insensitive" } },
          ],
        },
        orderBy: { slug: "asc" },
        take: limit,
        select: TAG_SELECT,
      });

      return rows.map(mapTag);
    },

    async setEventTags(eventId, tags) {
      // Delete all existing join rows for this event.
      await p.eventTag.deleteMany({ where: { eventId } });

      if (tags.length === 0) return [];

      // Ensure all tags exist, then create join rows.
      const results: EventTagWithTag[] = [];

      for (const { slug, name, sortOrder } of tags) {
        const tag = await p.tag.upsert({
          where: { slug },
          create: { slug, name },
          update: {},
          select: TAG_SELECT,
        });

        const eventTag = await p.eventTag.create({
          data: {
            eventId,
            tagId: tag.id,
            sortOrder,
          },
          select: {
            id: true,
            eventId: true,
            tagId: true,
            sortOrder: true,
            createdAt: true,
          },
        });

        results.push({
          ...eventTag,
          tag: mapTag(tag),
        });
      }

      return results;
    },

    async getEventTags(eventId) {
      const rows = await p.eventTag.findMany({
        where: { eventId },
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          eventId: true,
          tagId: true,
          sortOrder: true,
          createdAt: true,
          tag: { select: TAG_SELECT },
        },
      });

      return rows.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        tagId: row.tagId,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        tag: mapTag(row.tag),
      }));
    },
  } satisfies TagsRepo;
}
