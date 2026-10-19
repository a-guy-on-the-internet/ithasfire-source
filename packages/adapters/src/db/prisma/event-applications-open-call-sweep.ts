import { Prisma } from "@prisma/client";
import type {
  EventApplicationsRepo,
  OpenCallReconcileKind,
  OpenCallReconcileRow,
  OpenCallSweepDueRecord,
  OpenCallSweepVerdict,
} from "@th/ports/repos/events";

import { PERFORM_FORM, requireId } from "./event-applications-open-call-submissions";
import type { PrismaClientOrTx } from "./types";

/**
 * Open-call SWEEP + RECONCILE methods of the event-applications repo (open
 * calls v1 step 8, the `events.sweep-open-calls` job). Spread in through
 * `makeOpenCallDecisionMethods`.
 *
 * Every write is one guarded UPDATE whose `status = 'PENDING'` check is
 * re-evaluated under the row lock, so a pick / decline / withdraw / close
 * that commits first is never overwritten. All values are bind parameters.
 */

export type OpenCallSweepMethods = Pick<
  EventApplicationsRepo,
  | "listOpenCallSweepDue"
  | "settlePendingOpenCallSubmissions"
  | "expireUndecidedOpenCallSubmissions"
  | "listOpenCallSubmissionsByFormStatus"
  | "listOpenCallNoticeReconcileRows"
>;

/** Statuses each reconcile kind scans, and the column its window reads. */
const RECONCILE_SCAN: Record<
  OpenCallReconcileKind,
  { statuses: Array<"REJECTED" | "EXPIRED" | "PENDING" | "WAITLISTED">; at: "reviewedAt" | "createdAt" }
> = {
  "not-this-time": { statuses: ["REJECTED"], at: "reviewedAt" },
  pulled: { statuses: ["EXPIRED"], at: "reviewedAt" },
  received: { statuses: ["PENDING", "WAITLISTED"], at: "createdAt" },
};

type DueRow = {
  submissionId: string;
  formId: string;
  eventId: string | null;
  seriesId: string | null;
  title: string | null;
  verdict: OpenCallSweepVerdict;
  createdAt: Date;
};

export function makeOpenCallSweepMethods(p: PrismaClientOrTx): OpenCallSweepMethods {
  return {
    listOpenCallSweepDue: async (input) => {
      const limit = Math.max(1, Math.trunc(input.limit));
      // The rule is documented on the port (EventApplicationsRepo
      // .listOpenCallSweepDue); core's fake world mirrors it. `ch` is the
      // stored choices: how many, and the latest one not called off. `imp`
      // is an event call's implied night when nothing was stored.
      const rows = await p.$queryRaw<DueRow[]>(Prisma.sql`
        WITH base AS (
          SELECT
            s."id"        AS "submissionId",
            s."formId"    AS "formId",
            s."createdAt" AS "createdAt",
            f."eventId"   AS "eventId",
            f."seriesId"  AS "seriesId",
            COALESCE(e."title", ser."name") AS "title",
            e."status"::text AS "eventStatus",
            ser."archivedAt" AS "seriesArchivedAt",
            ch."choiceCount",
            ch."lastLive",
            CASE
              WHEN ch."choiceCount" > 0 THEN ch."lastLive"
              WHEN f."eventId" IS NULL THEN NULL
              WHEN EXISTS (SELECT 1 FROM "EventDate" d0 WHERE d0."eventId" = f."eventId") THEN (
                SELECT MIN(d."startsAt") FROM "EventDate" d
                WHERE d."eventId" = f."eventId"
                  AND d."status" = 'SCHEDULED'
                  AND d."startsAt" > s."createdAt"
              )
              ELSE e."startsAt"
            END AS "lastLiveDate"
          FROM "EventApplicationSubmission" s
          JOIN "EventApplicationForm" f ON f."id" = s."formId" AND f."purpose" = 'PERFORM'
          LEFT JOIN "Event" e ON e."id" = f."eventId"
          LEFT JOIN "EventSeries" ser ON ser."id" = f."seriesId"
          CROSS JOIN LATERAL (
            SELECT
              COUNT(*)::int AS "choiceCount",
              MAX(x."startsAt") FILTER (WHERE x."live") AS "lastLive"
            FROM (
              SELECT
                COALESCE(ed."startsAt", o."startsAt", ce."startsAt") AS "startsAt",
                CASE
                  WHEN c."eventDateId" IS NOT NULL THEN ed."status" = 'SCHEDULED'
                  WHEN c."occurrenceId" IS NOT NULL THEN
                    o."status" IN ('PLANNED', 'GENERATED', 'PUBLISHED')
                    AND (oe."id" IS NULL OR oe."status" <> 'CANCELLED')
                  ELSE ce."status" <> 'CANCELLED'
                END AS "live"
              FROM "OpenCallDateChoice" c
              LEFT JOIN "EventDate" ed ON ed."id" = c."eventDateId"
              LEFT JOIN "EventSeriesOccurrence" o ON o."id" = c."occurrenceId"
              LEFT JOIN "Event" oe ON oe."id" = o."eventId"
              LEFT JOIN "Event" ce ON ce."id" = c."eventId"
              WHERE c."submissionId" = s."id"
            ) x
          ) ch
          WHERE s."status" = 'PENDING'
        ),
        judged AS (
          SELECT
            b.*,
            CASE
              WHEN b."eventId" IS NOT NULL AND b."eventStatus" = 'CANCELLED' THEN 'pulled'
              WHEN b."lastLiveDate" IS NULL THEN 'pulled'
              WHEN b."lastLiveDate" <= ${input.now}::timestamp THEN 'backstop'
              WHEN b."eventStatus" IN ('ARCHIVED', 'COMPLETED')
                OR b."seriesArchivedAt" IS NOT NULL THEN 'pulled'
              ELSE NULL
            END AS "verdict"
          FROM base b
        )
        SELECT "submissionId", "formId", "eventId", "seriesId", "title", "verdict", "createdAt"
        FROM judged
        WHERE "verdict" IS NOT NULL
        ORDER BY "createdAt" ASC, "submissionId" ASC
        LIMIT ${limit}
      `);
      return rows.map(
        (r): OpenCallSweepDueRecord => ({
          submissionId: r.submissionId,
          formId: r.formId,
          eventId: r.eventId,
          seriesId: r.seriesId,
          title: r.title ?? "",
          verdict: r.verdict,
          createdAt: r.createdAt,
        }),
      );
    },

    settlePendingOpenCallSubmissions: async (input) => {
      if (input.submissionIds.length === 0) return { ids: [] };
      if (input.status !== "REJECTED" && input.status !== "EXPIRED") {
        throw new Error("eventApplications.settlePendingOpenCallSubmissions: status must be REJECTED or EXPIRED");
      }
      const ids = input.submissionIds.map((id) =>
        requireId(id, "settlePendingOpenCallSubmissions", "submissionId"),
      );
      // One statement; the PENDING guard and the PERFORM join are both
      // re-checked under each row's lock.
      const rows = await p.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "EventApplicationSubmission" s
        SET "status" = ${input.status}::"ApplicationSubmissionStatus",
            "reviewedAt" = ${input.reviewedAt}::timestamp,
            "updatedAt" = ${input.reviewedAt}::timestamp
        FROM "EventApplicationForm" f
        WHERE s."id" = ANY(${ids}::text[])
          AND s."status" = 'PENDING'
          AND f."id" = s."formId"
          AND f."purpose" = 'PERFORM'
        RETURNING s."id"
      `);
      return { ids: rows.map((r) => r.id) };
    },

    expireUndecidedOpenCallSubmissions: async (input) => {
      const formId = requireId(input.formId, "expireUndecidedOpenCallSubmissions", "formId");
      // Mirrors rejectPendingOpenCallSubmissions: scalar-only filter, callers
      // pass a formId read through the PERFORM-only methods.
      const rows = await p.eventApplicationSubmission.updateManyAndReturn({
        where: { formId, status: { in: ["PENDING", "WAITLISTED"] } },
        data: { status: "EXPIRED", reviewedAt: input.reviewedAt },
        select: { id: true },
      });
      return { ids: rows.map((r) => r.id) };
    },

    listOpenCallSubmissionsByFormStatus: async (input) => {
      const formId = requireId(input.formId, "listOpenCallSubmissionsByFormStatus", "formId");
      const statuses = input.statuses.filter((st) => st === "REJECTED" || st === "EXPIRED");
      if (statuses.length === 0) return [];
      const rows = await p.eventApplicationSubmission.findMany({
        where: {
          formId,
          form: PERFORM_FORM,
          status: { in: statuses },
          ...(input.afterId ? { id: { gt: input.afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: Math.max(1, Math.trunc(input.limit)),
        select: { id: true, status: true },
      });
      return rows.map((r) => ({
        submissionId: r.id,
        status: r.status === "REJECTED" ? ("REJECTED" as const) : ("EXPIRED" as const),
      }));
    },

    listOpenCallNoticeReconcileRows: async (input) => {
      const scan = RECONCILE_SCAN[input.kind];
      if (!scan) throw new Error(`eventApplications.listOpenCallNoticeReconcileRows: unknown kind`);
      const limit = Math.max(1, Math.trunc(input.limit));
      const col = scan.at;
      type AtFilter = { gte?: Date; lte?: Date; gt?: Date } | Date;
      const at = (f: AtFilter): Prisma.EventApplicationSubmissionWhereInput =>
        col === "reviewedAt" ? { reviewedAt: f } : { createdAt: f };
      const rows = await p.eventApplicationSubmission.findMany({
        where: {
          form: PERFORM_FORM,
          status: { in: scan.statuses },
          AND: [
            at({ gte: input.since, lte: input.until }),
            ...(input.after
              ? [
                  {
                    OR: [
                      at({ gt: input.after.at }),
                      { AND: [at(input.after.at), { id: { gt: input.after.submissionId } }] },
                    ],
                  },
                ]
              : []),
          ],
        },
        orderBy:
          col === "reviewedAt"
            ? [{ reviewedAt: "asc" }, { id: "asc" }]
            : [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
        select: {
          id: true,
          formId: true,
          reviewedAt: true,
          createdAt: true,
          form: {
            select: {
              eventId: true,
              seriesId: true,
              event: { select: { title: true } },
              series: { select: { name: true } },
            },
          },
        },
      });
      return rows.map(
        (r): OpenCallReconcileRow => ({
          submissionId: r.id,
          formId: r.formId,
          eventId: r.form.eventId,
          seriesId: r.form.seriesId,
          title: r.form.event?.title ?? r.form.series?.name ?? "",
          // The window filter guarantees reviewedAt is set for those kinds.
          at: (col === "reviewedAt" ? r.reviewedAt : r.createdAt) ?? r.createdAt,
        }),
      );
    },
  };
}
