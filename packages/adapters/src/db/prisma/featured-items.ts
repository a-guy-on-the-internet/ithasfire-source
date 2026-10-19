import type { Prisma } from "@prisma/client";
import type {
  FeaturedItemRecord,
  FeaturedItemsRepo,
} from "@th/ports/repos/featured-items";
import type { PrismaClientOrTx } from "./types";

const FEATURED_ITEM_SELECT = {
  id: true,
  itemType: true,
  itemId: true,
  title: true,
  subtitle: true,
  heroImageUrl: true,
  ctaUrl: true,
  ctaLabel: true,
  sortOrder: true,
  active: true,
  curatedByHumanId: true,
  curatedAt: true,
  curatedUntil: true,
  notes: true,
} as const;

type FeaturedItemSelectResult = Prisma.FeaturedItemGetPayload<{
  select: typeof FEATURED_ITEM_SELECT;
}>;

const mapFeaturedItem = (
  record: FeaturedItemSelectResult,
): FeaturedItemRecord => ({
  id: record.id,
  itemType: record.itemType,
  itemId: record.itemId,
  title: record.title ?? null,
  subtitle: record.subtitle ?? null,
  heroImageUrl: record.heroImageUrl ?? null,
  ctaUrl: record.ctaUrl ?? null,
  ctaLabel: record.ctaLabel ?? null,
  sortOrder: record.sortOrder,
  active: record.active,
  curatedByHumanId: record.curatedByHumanId ?? null,
  curatedAt: record.curatedAt,
  curatedUntil: record.curatedUntil ?? null,
  notes: record.notes ?? null,
});

export function makeFeaturedItemsRepo(p: PrismaClientOrTx): FeaturedItemsRepo {
  return {
    upsert: async ({
      itemType,
      itemId,
      title,
      subtitle,
      heroImageUrl,
      ctaUrl,
      ctaLabel,
      sortOrder,
      active,
      curatedByHumanId,
      curatedAt,
      curatedUntil,
      notes,
    }) => {
      const data = {
        title: title ?? null,
        subtitle: subtitle ?? null,
        heroImageUrl: heroImageUrl ?? null,
        ctaUrl: ctaUrl ?? null,
        ctaLabel: ctaLabel ?? null,
        sortOrder: sortOrder ?? 0,
        active: active ?? true,
        curatedByHumanId,
        curatedAt,
        curatedUntil: curatedUntil ?? null,
        notes: notes ?? null,
      };

      const record = await p.featuredItem.upsert({
        where: { itemType_itemId: { itemType, itemId } },
        update: data,
        create: { itemType, itemId, ...data },
        select: FEATURED_ITEM_SELECT,
      });

      return mapFeaturedItem(record);
    },

    remove: async ({ itemType, itemId }) => {
      await p.featuredItem.deleteMany({
        where: { itemType, itemId },
      });
    },

    listActive: async ({ now, limit, itemType = null }) => {
      const sanitizedLimit = Math.min(Math.max(limit, 1), 100);

      const where: Prisma.FeaturedItemWhereInput = {
        active: true,
        OR: [{ curatedUntil: null }, { curatedUntil: { gte: now } }],
        ...(itemType ? { itemType } : {}),
      };

      const records = await p.featuredItem.findMany({
        where,
        orderBy: [{ sortOrder: "asc" }, { curatedAt: "desc" }],
        take: sanitizedLimit,
        select: FEATURED_ITEM_SELECT,
      });

      return records.map(mapFeaturedItem);
    },

    listAll: async ({ limit, offset }) => {
      const sanitizedLimit = Math.min(Math.max(limit, 1), 100);
      const sanitizedOffset = Math.max(offset, 0);

      const [items, total] = await Promise.all([
        p.featuredItem.findMany({
          orderBy: [{ sortOrder: "asc" }, { curatedAt: "desc" }],
          take: sanitizedLimit,
          skip: sanitizedOffset,
          select: FEATURED_ITEM_SELECT,
        }),
        p.featuredItem.count(),
      ]);

      return { items: items.map(mapFeaturedItem), total };
    },

    findByTypeAndId: async ({ itemType, itemId }) => {
      const record = await p.featuredItem.findUnique({
        where: { itemType_itemId: { itemType, itemId } },
        select: FEATURED_ITEM_SELECT,
      });

      return record ? mapFeaturedItem(record) : null;
    },
  } satisfies FeaturedItemsRepo;
}
