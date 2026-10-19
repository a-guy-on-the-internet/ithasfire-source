import { Prisma, type $Enums } from "@prisma/client";
import type {
  EntityReportReason,
  EntityReportRecord,
  EntityReportStatus,
  EntityReportSubjectSnapshot,
  EntityReportSubjectType,
  EntityReportsRepo,
} from "@th/ports/repos/entity-reports";

// Compile-time mutual-assignability guard backing the `mapRecord` casts below:
// the port's string unions and the Prisma enums must stay literal-for-literal
// identical in BOTH directions (a member added to either side without the
// other is a type error here). Zero runtime cost.
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;
const _subjectTypeParity: MutuallyAssignable<
  EntityReportSubjectType,
  $Enums.EntityReportSubjectType
> = true;
const _reasonParity: MutuallyAssignable<
  EntityReportReason,
  $Enums.EntityReportReason
> = true;
const _statusParity: MutuallyAssignable<
  EntityReportStatus,
  $Enums.EntityReportStatus
> = true;
void _subjectTypeParity;
void _reasonParity;
void _statusParity;

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const REPORT_SELECT = {
  id: true,
  subjectType: true,
  subjectId: true,
  reporterHumanId: true,
  reason: true,
  details: true,
  subjectSnapshot: true,
  status: true,
  reviewedByHumanId: true,
  reviewedAt: true,
  reviewNote: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The port declares its own string unions so core never imports
// `@prisma/client`; the Prisma enums are literal-for-literal identical, so the
// casts here are shape-preserving (same posture as event-change-notices'
// changeType mapping).
const mapRecord = (row: {
  id: string;
  subjectType: string;
  subjectId: string;
  reporterHumanId: string;
  reason: string;
  details: string | null;
  subjectSnapshot: Prisma.JsonValue | null;
  status: string;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EntityReportRecord => ({
  id: row.id,
  subjectType: row.subjectType as EntityReportSubjectType,
  subjectId: row.subjectId,
  reporterHumanId: row.reporterHumanId,
  reason: row.reason as EntityReportReason,
  details: row.details ?? null,
  // Written only by `create` below from core's validated snapshot; core
  // re-parses it on the way out (entityReportRecordSchema).
  subjectSnapshot:
    (row.subjectSnapshot as EntityReportSubjectSnapshot | null) ?? null,
  status: row.status as EntityReportStatus,
  reviewedByHumanId: row.reviewedByHumanId ?? null,
  reviewedAt: row.reviewedAt ?? null,
  reviewNote: row.reviewNote ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeEntityReportsRepo(p: PrismaClientOrTx): EntityReportsRepo {
  return {
    async create(input) {
      try {
        const row = await p.entityReport.create({
          data: {
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            reporterHumanId: input.reporterHumanId,
            reason: input.reason,
            details: input.details ?? null,
            subjectSnapshot: input.subjectSnapshot
              ? (input.subjectSnapshot as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
          select: REPORT_SELECT,
        });
        return mapRecord(row);
      } catch (error) {
        // P2002 on create can only come from the SQL-only partial unique
        // index "EntityReport_open_reporter_subject_key" ON (reporterHumanId,
        // subjectType, subjectId) WHERE status = 'PENDING' — see
        // moderation.prisma / migration 20260817130000: `id` is a fresh uuid
        // and nothing else on the row is unique. Map the race loser to the
        // same domain error as the use-case pre-check path
        // (findPendingByReporterAndSubject) so a raw P2002 never leaks
        // through the port. Same contract as bookingRequests'
        // `duplicate_open_request` mapping.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "report_already_open",
            message: "report_already_open",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getById(id) {
      const row = await p.entityReport.findUnique({
        where: { id },
        select: REPORT_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    // Best-effort dedupe pre-check only — the partial unique index behind
    // `create` stays the authoritative race guard (port contract; same
    // posture as bookingRequests.findOpenByOrganizerAndPerformer).
    async findPendingByReporterAndSubject(input) {
      const row = await p.entityReport.findFirst({
        where: {
          reporterHumanId: input.reporterHumanId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          status: "PENDING",
        },
        select: REPORT_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    // Newest first (createdAt desc, id desc) matching the eventEditSuggestions
    // / categoryRequests admin-queue convention; keyset cursor = report id.
    // `status` defaults to PENDING — this list is queue-shaped, so omitting
    // the filter must never silently widen to RESOLVED/DISMISSED rows (port
    // contract on ListEntityReportsPagedInput.status).
    async listPaged({ status, subjectType, cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.entityReport.findMany({
        where: {
          status: status ?? "PENDING",
          ...(subjectType ? { subjectType } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: REPORT_SELECT,
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(mapRecord);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    // Counting twin of listPaged's DEFAULT row set — same WHERE (status
    // PENDING + optional subjectType), so the badge count can never disagree
    // with the queue it summarizes.
    async countPending(input) {
      return p.entityReport.count({
        where: {
          status: "PENDING",
          ...(input?.subjectType ? { subjectType: input.subjectType } : {}),
        },
      });
    },

    // Single-step CAS: the PENDING guard in the WHERE clause makes the loser
    // of a concurrent double-review match zero rows and see null (mirrors
    // eventEditSuggestions.claimPendingForReview's loser expression, collapsed
    // to one step because a report verdict has no apply phase).
    async claimPendingForReview(input) {
      const result = await p.entityReport.updateMany({
        where: { id: input.id, status: "PENDING" },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote ?? null,
        },
      });
      if (result.count !== 1) {
        return null;
      }

      const row = await p.entityReport.findUnique({
        where: { id: input.id },
        select: REPORT_SELECT,
      });
      return row ? mapRecord(row) : null;
    },
  } satisfies EntityReportsRepo;
}
