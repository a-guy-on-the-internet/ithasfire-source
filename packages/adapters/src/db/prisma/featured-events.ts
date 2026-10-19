import type { Prisma } from "@prisma/client";
import type {
  FeaturedEventRecord,
  FeaturedEventWithEventRecord,
  FeaturedEventsRepo,
} from "@th/ports/repos/featured-events";
import { EVENT_SELECT, mapEvent } from "./events";
import type { PrismaClientOrTx } from "./types";
import { notWithheldEventWhere } from "./banned-owner";

const FEATURED_EVENT_SELECT = {
  id: true,
  eventId: true,
  curatedByHumanId: true,
  curatedAt: true,
  curatedUntil: true,
  notes: true,
} as const;

type FeaturedEventSelectResult = Prisma.FeaturedEventGetPayload<{
  select: typeof FEATURED_EVENT_SELECT;
}>;
type FeaturedEventWithEventSelect = Prisma.FeaturedEventGetPayload<{
  select: typeof FEATURED_EVENT_SELECT & {
    event: { select: typeof EVENT_SELECT };
  };
}>;

const mapFeaturedEvent = (
  record: FeaturedEventSelectResult,
): FeaturedEventRecord => ({
  id: record.id,
  eventId: record.eventId,
  curatedByHumanId: record.curatedByHumanId ?? null,
  curatedAt: record.curatedAt,
  curatedUntil: record.curatedUntil ?? null,
  notes: record.notes ?? null,
});

const mapFeaturedWithEvent = (
  record: FeaturedEventWithEventSelect,
): FeaturedEventWithEventRecord => ({
  featured: mapFeaturedEvent(record),
  event: mapEvent(record.event),
});

export function makeFeaturedEventsRepo(
  p: PrismaClientOrTx,
): FeaturedEventsRepo {
  return {
    upsertPlacement: async ({
      eventId,
      curatedByHumanId,
      curatedAt,
      curatedUntil,
      notes,
    }) => {
      const record = await p.featuredEvent.upsert({
        where: { eventId },
        update: {
          curatedByHumanId,
          curatedAt,
          curatedUntil,
          notes: notes ?? null,
        },
        create: {
          eventId,
          curatedByHumanId,
          curatedAt,
          curatedUntil,
          notes: notes ?? null,
        },
        select: FEATURED_EVENT_SELECT,
      });

      return mapFeaturedEvent(record);
    },
    listActive: async ({ now, limit, categorySlug = null }) => {
      const sanitizedLimit = Math.min(Math.max(limit, 1), 48);

      const records = await p.featuredEvent.findMany({
        where: {
          OR: [{ curatedUntil: null }, { curatedUntil: { gte: now } }],
          event: {
            status: "PUBLISHED",
            // A public rail: an event made PRIVATE after it was featured must
            // drop off it, not keep advertising a link-only event.
            visibility: "PUBLIC",
            // A banned owner's event drops off the rail (banned-owner.ts).
            ...(await notWithheldEventWhere(p)),
            ...(categorySlug
              ? {
                  category: {
                    slug: categorySlug,
                    active: true,
                  },
                }
              : {}),
          },
        },
        orderBy: [{ curatedUntil: "asc" }, { curatedAt: "desc" }],
        take: sanitizedLimit,
        select: {
          ...FEATURED_EVENT_SELECT,
          event: {
            select: EVENT_SELECT,
          },
        },
      });

      return records.map(mapFeaturedWithEvent);
    },
  } satisfies FeaturedEventsRepo;
}
