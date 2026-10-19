import { Prisma } from "@prisma/client";
import type {
  ListReviewAggregateSubjectIdsInput,
  ReviewAggregateRecord,
  ReviewAggregatesRepo,
  SetReviewAggregateInput,
} from "@th/ports/repos/review-aggregates";

import type { PrismaClientOrTx } from "./types";

type AggregateRow = {
  id: string;
  subjectType: "EVENT" | "PLACE" | "OWNER" | "SERIES";
  subjectId: string;
  snapshot: unknown;
  computedAt: Date;
};

const mapRecord = (row: AggregateRow): ReviewAggregateRecord => ({
  id: row.id,
  subjectType: row.subjectType,
  subjectId: row.subjectId,
  snapshot: row.snapshot ?? null,
  computedAt: row.computedAt,
});

export function makeReviewAggregatesRepo(
  p: PrismaClientOrTx,
): ReviewAggregatesRepo {
  return {
    async getBySubject({ subjectType, subjectId }) {
      const row = await p.reviewAggregate.findUnique({
        where: { subjectType_subjectId: { subjectType, subjectId } },
      });
      return row ? mapRecord(row) : null;
    },

    async setSnapshot(input: SetReviewAggregateInput) {
      const data = {
        snapshot: input.snapshot as Prisma.InputJsonValue,
        computedAt: input.computedAt,
      };
      await p.reviewAggregate.upsert({
        where: {
          subjectType_subjectId: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
          },
        },
        create: {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          ...data,
        },
        update: data,
      });
    },

    async listSubjectIdsWithAggregate(
      input: ListReviewAggregateSubjectIdsInput,
    ) {
      const rows = await p.reviewAggregate.findMany({
        where: {
          subjectType: input.subjectType,
          ...(input.afterSubjectId
            ? { subjectId: { gt: input.afterSubjectId } }
            : {}),
        },
        select: { subjectId: true },
        orderBy: { subjectId: "asc" },
        take: input.limit,
      });
      return rows.map((r) => r.subjectId);
    },
  };
}
