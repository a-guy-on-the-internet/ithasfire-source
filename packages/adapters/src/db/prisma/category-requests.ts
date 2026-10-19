import type {
  CategoryRequestsRepo,
  EventCategoryRequestKind,
  EventCategoryRequestRecord,
  EventCategoryRequestStatus,
  FindPendingCategoryRequestInput,
  ListCategoryRequestsInput,
} from "@th/ports/repos/category-requests";

import type { PrismaClientOrTx } from "./types";

const CATEGORY_REQUEST_SELECT = {
  id: true,
  kind: true,
  status: true,
  name: true,
  slug: true,
  categoryId: true,
  categorySlug: true,
  categoryName: true,
  eventId: true,
  requesterHumanId: true,
  reviewedByHumanId: true,
  reviewNote: true,
  resolvedCategoryId: true,
  locale: true,
  createdAt: true,
  updatedAt: true,
  reviewedAt: true,
} as const;

const mapRecord = (row: any): EventCategoryRequestRecord => ({
  id: row.id,
  kind: row.kind as EventCategoryRequestKind,
  status: row.status as EventCategoryRequestStatus,
  name: row.name,
  slug: row.slug,
  categoryId: row.categoryId ?? null,
  categorySlug: row.categorySlug ?? null,
  categoryName: row.categoryName ?? null,
  eventId: row.eventId ?? null,
  requesterHumanId: row.requesterHumanId,
  reviewedByHumanId: row.reviewedByHumanId ?? null,
  reviewNote: row.reviewNote ?? null,
  resolvedCategoryId: row.resolvedCategoryId ?? null,
  locale: row.locale ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  reviewedAt: row.reviewedAt ?? null,
});

export function makeCategoryRequestsRepo(
  p: PrismaClientOrTx,
): CategoryRequestsRepo {
  const model = (p as any).eventCategoryRequest;

  const findPendingRecord = async (
    input: FindPendingCategoryRequestInput,
  ): Promise<EventCategoryRequestRecord | null> => {
    const row = await model.findFirst({
      where: {
        status: "PENDING",
        kind: input.kind,
        slug: input.slug,
        categoryId: input.categoryId ?? null,
      },
      orderBy: { createdAt: "asc" },
      select: CATEGORY_REQUEST_SELECT,
    });
    return row ? mapRecord(row) : null;
  };

  return {
    async create(input) {
      await model.createMany({
        data: [
          {
            kind: input.kind,
            name: input.name,
            slug: input.slug,
            categoryId: input.categoryId ?? null,
            categorySlug: input.categorySlug ?? null,
            categoryName: input.categoryName ?? null,
            eventId: input.eventId ?? null,
            requesterHumanId: input.requesterHumanId,
            reviewNote: input.reviewNote ?? null,
            locale: input.locale ?? null,
          },
        ],
        skipDuplicates: true,
      });

      const pending = await findPendingRecord({
        kind: input.kind,
        slug: input.slug,
        categoryId: input.categoryId ?? null,
      });
      if (!pending) {
        throw new Error("category_request_create_failed");
      }

      return pending;
    },

    async findPending(input) {
      return findPendingRecord(input);
    },

    async listPendingBySlug(slug) {
      const rows = await model.findMany({
        where: { status: "PENDING", kind: "CATEGORY", categoryId: null, slug },
        orderBy: { createdAt: "asc" },
        select: CATEGORY_REQUEST_SELECT,
      });
      return rows.map(mapRecord);
    },

    async getById(id) {
      const row = await model.findUnique({
        where: { id },
        select: CATEGORY_REQUEST_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async list(input: ListCategoryRequestsInput) {
      const where = {
        ...(input.status ? { status: input.status } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      };

      const [requests, total] = await Promise.all([
        model.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit,
          skip: input.offset,
          select: CATEGORY_REQUEST_SELECT,
        }),
        model.count({ where }),
      ]);

      return {
        requests: requests.map(mapRecord),
        total,
      };
    },

    async claimPendingForReview(input) {
      const result = await model.updateMany({
        where: {
          id: input.id,
          status: "PENDING",
          reviewedByHumanId: null,
          reviewedAt: null,
        },
        data: {
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
        },
      });
      if (result.count !== 1) {
        return null;
      }

      const row = await model.findUnique({
        where: { id: input.id },
        select: CATEGORY_REQUEST_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async markReviewed(input) {
      const row = await model.update({
        where: { id: input.id },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote ?? null,
          resolvedCategoryId: input.resolvedCategoryId ?? null,
        },
        select: CATEGORY_REQUEST_SELECT,
      });
      return mapRecord(row);
    },
  } satisfies CategoryRequestsRepo;
}
