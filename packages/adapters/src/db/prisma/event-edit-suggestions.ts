import { Prisma } from "@prisma/client";
import type {
  EventEditSuggestionsRepo,
  ListPendingEventEditSuggestionsScope,
} from "@th/ports/repos/event-edit-suggestions";
import type {
  EventEditSuggestionRecord,
  EventEditSuggestionStatus,
} from "@th/types";

import type { PrismaClientOrTx } from "./types";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const SUGGESTION_SELECT = {
  id: true,
  eventId: true,
  submitterHumanId: true,
  submitterIpHash: true,
  fields: true,
  baseVersion: true,
  note: true,
  status: true,
  reviewedByHumanId: true,
  reviewedAt: true,
  reviewNote: true,
  appliedFields: true,
  conflictedFields: true,
  createdAt: true,
  updatedAt: true,
} as const;

const mapRecord = (row: any): EventEditSuggestionRecord => ({
  id: row.id,
  eventId: row.eventId,
  submitterHumanId: row.submitterHumanId ?? null,
  submitterIpHash: row.submitterIpHash ?? null,
  fields: row.fields as Record<string, unknown>,
  baseVersion: row.baseVersion as Record<string, unknown>,
  note: row.note ?? null,
  status: row.status as EventEditSuggestionStatus,
  reviewedByHumanId: row.reviewedByHumanId ?? null,
  reviewedAt: row.reviewedAt ?? null,
  reviewNote: row.reviewNote ?? null,
  appliedFields: (row.appliedFields ?? null) as Record<string, unknown> | null,
  conflictedFields: (row.conflictedFields ?? null) as string[] | null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/**
 * Scope resolution happens AT QUERY TIME through the Event relation (FR-008 /
 * FR-016) — nothing scope-related is denormalized onto the suggestion row.
 */
const scopeWhere = (
  scope: ListPendingEventEditSuggestionsScope,
): Prisma.EventEditSuggestionWhereInput => {
  switch (scope.kind) {
    case "community":
      return { event: { stewardship: "COMMUNITY" } };
    case "org":
      return { event: { orgId: scope.orgId } };
    case "event":
      return { eventId: scope.eventId };
  }
};

function getSafeLimit(limit?: number) {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

export function makeEventEditSuggestionsRepo(
  p: PrismaClientOrTx,
): EventEditSuggestionsRepo {
  return {
    async create(input) {
      const row = await p.eventEditSuggestion.create({
        data: {
          eventId: input.eventId,
          submitterHumanId: input.submitterHumanId ?? null,
          submitterIpHash: input.submitterIpHash ?? null,
          fields: input.fields as Prisma.InputJsonValue,
          baseVersion: input.baseVersion as Prisma.InputJsonValue,
          note: input.note ?? null,
        },
        select: SUGGESTION_SELECT,
      });
      return mapRecord(row);
    },

    async getById(id) {
      const row = await p.eventEditSuggestion.findUnique({
        where: { id },
        select: SUGGESTION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async listPendingReferenceFields(eventIds) {
      if (eventIds.length === 0) return [];
      const rows = await p.eventEditSuggestion.findMany({
        where: { eventId: { in: eventIds }, status: "PENDING" },
        select: { eventId: true, fields: true },
      });
      return rows.map((row) => ({
        eventId: row.eventId,
        fields: row.fields ?? null,
      }));
    },

    // Newest first (createdAt desc, id desc) matching the categoryRequests
    // admin-queue convention; keyset cursor = suggestion id, same scheme as
    // eventSaves.listForHuman.
    async listPending({ scope, cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.eventEditSuggestion.findMany({
        where: {
          status: "PENDING",
          ...scopeWhere(scope),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: SUGGESTION_SELECT,
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map(mapRecord);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    // Submitter-facing list (all statuses) for the "my edit suggestions" view.
    // Querying by a concrete submitterHumanId inherently excludes anonymous
    // rows (submitterHumanId = null). Newest first, same keyset cursor scheme
    // as listPending (cursor = suggestion id, orderBy createdAt desc, id desc).
    // The Event relation is joined to hydrate the target's title + current slug.
    async listBySubmitter({ submitterHumanId, cursor, limit }) {
      const safeLimit = getSafeLimit(limit);
      const rows = await p.eventEditSuggestion.findMany({
        where: { submitterHumanId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(cursor
          ? {
              cursor: { id: cursor },
              skip: 1,
            }
          : {}),
        take: safeLimit + 1,
        select: {
          ...SUGGESTION_SELECT,
          event: { select: { title: true, slug: true } },
        },
      });

      const hasMore = rows.length > safeLimit;
      const items = (hasMore ? rows.slice(0, safeLimit) : rows).map((row) => ({
        ...mapRecord(row),
        eventTitle: row.event.title,
        eventSlug: row.event.slug ?? null,
      }));

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    // Claim stamps reviewedByHumanId/reviewedAt while status STAYS PENDING —
    // the status only flips in markReviewed. Mirrors
    // categoryRequests.claimPendingForReview: the atomic updateMany with the
    // PENDING + unreviewed guard makes the loser of a concurrent double-review
    // match zero rows and see null.
    async claimPendingForReview(input) {
      const result = await p.eventEditSuggestion.updateMany({
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

      const row = await p.eventEditSuggestion.findUnique({
        where: { id: input.id },
        select: SUGGESTION_SELECT,
      });
      return row ? mapRecord(row) : null;
    },

    async markReviewed(input) {
      const row = await p.eventEditSuggestion.update({
        where: { id: input.id },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote ?? null,
          appliedFields:
            input.appliedFields == null
              ? Prisma.DbNull
              : (input.appliedFields as Prisma.InputJsonValue),
          conflictedFields:
            input.conflictedFields == null
              ? Prisma.DbNull
              : (input.conflictedFields as unknown as Prisma.InputJsonValue),
        },
        select: SUGGESTION_SELECT,
      });
      return mapRecord(row);
    },

    // Soft per-IP flood cap support (NFR-001) — a count, not a hard gate.
    // Counting twin of listBySubmitter — same where clause, so a non-zero
    // count always means that list has rows.
    async countBySubmitter(submitterHumanId) {
      return p.eventEditSuggestion.count({ where: { submitterHumanId } });
    },

    async countPendingByIp({ submitterIpHash, since }) {
      return p.eventEditSuggestion.count({
        where: {
          status: "PENDING",
          submitterIpHash,
          createdAt: { gte: since },
        },
      });
    },

    async clearSubmitterIpHashesBefore({ before }) {
      const { count } = await p.eventEditSuggestion.updateMany({
        where: { submitterIpHash: { not: null }, createdAt: { lt: before } },
        data: { submitterIpHash: null },
      });
      return { count };
    },

    async countPendingByEvent(eventId) {
      return p.eventEditSuggestion.count({
        where: { eventId, status: "PENDING" },
      });
    },
  } satisfies EventEditSuggestionsRepo;
}
