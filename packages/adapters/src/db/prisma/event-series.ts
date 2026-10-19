import { Prisma } from "@prisma/client";
import type {
  ApplyOccurrenceOverridesInput,
  ArchiveEventSeriesRepoInput,
  AttachEventToOccurrenceInput,
  BulkDeletePlannedInput,
  BulkDetachInput,
  BulkUpsertEventSeriesOccurrencesInput,
  CreateEventSeriesOccurrenceInput,
  CreateEventSeriesRepoInput,
  EventSeriesDefaults,
  EventSeriesListFilters,
  EventSeriesListResult,
  EventSeriesOccurrenceListFilters,
  EventSeriesOccurrenceListResult,
  EventSeriesOccurrenceOverrides,
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
  EventSeriesSchedule,
  EventSeriesCalendarInfo,
  MarkOccurrenceStatusInput,
  PublicSeriesDateRecord,
  UniqueOccurrenceCheckInput,
  UpdateEventSeriesRepoPatch,
} from "@th/types";
import type {
  EventSeriesOccurrencesRepo,
  EventSeriesRepo,
} from "@th/ports/repos/event-series";
import { fail } from "@th/errors";

import type { PrismaClientOrTx } from "./types";

const SERIES_ORDER_BY: Prisma.EventSeriesOrderByWithRelationInput[] = [
  { createdAt: "desc" },
  { id: "desc" },
];

const OCCURRENCE_ORDER_BY: Prisma.EventSeriesOccurrenceOrderByWithRelationInput[] =
  [{ startsAt: "asc" }, { id: "asc" }];

type SeriesModel = Prisma.EventSeriesGetPayload<{
  select: typeof SERIES_BASE_SELECT;
}>;
type OccurrenceModel = Prisma.EventSeriesOccurrenceGetPayload<{
  select: typeof OCCURRENCE_BASE_SELECT;
}>;

const SERIES_BASE_SELECT = {
  id: true,
  ownerScope: true,
  ownerId: true,
  name: true,
  nameNormalized: true,
  description: true,
  active: true,
  timezone: true,
  schedule: true,
  templateId: true,
  defaults: true,
  createdByHumanId: true,
  updatedByHumanId: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.EventSeriesSelect;

const OCCURRENCE_BASE_SELECT = {
  id: true,
  seriesId: true,
  ordinal: true,
  startsAt: true,
  endsAt: true,
  status: true,
  eventId: true,
  overrides: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EventSeriesOccurrenceSelect;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function toNullableJson(
  value: unknown | null | undefined,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return Prisma.DbNull;
  }
  return value as Prisma.InputJsonValue;
}

function fromNullableJson<T>(
  value: Prisma.JsonValue | null | undefined,
): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = value as unknown;
  if (
    raw === Prisma.DbNull ||
    raw === Prisma.JsonNull ||
    raw === Prisma.AnyNull
  ) {
    return null;
  }
  return value as T;
}

function mapSeries(model: SeriesModel): EventSeriesRecord {
  return {
    id: model.id,
    ownerScope: model.ownerScope,
    ownerId: model.ownerId,
    name: model.name,
    description: model.description,
    active: model.active,
    timezone: model.timezone,
    schedule: model.schedule as unknown as EventSeriesSchedule,
    templateId: model.templateId,
    defaults: fromNullableJson<EventSeriesDefaults>(model.defaults),
    createdByHumanId: model.createdByHumanId,
    updatedByHumanId: model.updatedByHumanId,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    archivedAt: model.archivedAt,
  } satisfies EventSeriesRecord;
}

function buildSeriesCursor(series: { createdAt: Date; id: string }): string {
  return `${series.createdAt.getTime()}::${series.id}`;
}

function parseSeriesCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  const [timestamp, id] = cursor.split("::");
  if (!timestamp || !id) {
    return null;
  }

  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) {
    return null;
  }

  return { createdAt: new Date(ms), id };
}

function applySeriesFilters(
  filters: EventSeriesListFilters,
): Prisma.EventSeriesWhereInput {
  const clauses: Prisma.EventSeriesWhereInput[] = [
    { ownerScope: filters.ownerScope },
    { ownerId: filters.ownerId },
  ];

  if (filters.activeOnly) {
    clauses.push({ active: true, archivedAt: null });
  }

  if (filters.q) {
    clauses.push({ name: { contains: filters.q, mode: "insensitive" } });
  }

  return { AND: clauses } satisfies Prisma.EventSeriesWhereInput;
}

function mapOccurrence(model: OccurrenceModel): EventSeriesOccurrenceRecord {
  return {
    id: model.id,
    seriesId: model.seriesId,
    ordinal: model.ordinal,
    startsAt: model.startsAt,
    endsAt: model.endsAt,
    status: model.status,
    eventId: model.eventId,
    overrides: fromNullableJson<EventSeriesOccurrenceOverrides>(
      model.overrides,
    ),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  } satisfies EventSeriesOccurrenceRecord;
}

function buildOccurrenceCursor(occurrence: {
  startsAt: Date;
  id: string;
}): string {
  return `${occurrence.startsAt.getTime()}::${occurrence.id}`;
}

function parseOccurrenceCursor(
  cursor: string,
): { startsAt: Date; id: string } | null {
  const [timestamp, id] = cursor.split("::");
  if (!timestamp || !id) {
    return null;
  }

  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) {
    return null;
  }

  return { startsAt: new Date(ms), id };
}

function applyOccurrenceFilters(
  filters: EventSeriesOccurrenceListFilters,
): Prisma.EventSeriesOccurrenceWhereInput {
  const clauses: Prisma.EventSeriesOccurrenceWhereInput[] = [
    { seriesId: filters.seriesId },
  ];

  if (filters.range) {
    clauses.push({
      startsAt: { gte: filters.range.start, lte: filters.range.end },
    });
  }

  if (filters.status && filters.status.length > 0) {
    clauses.push({ status: { in: filters.status } });
  }

  return { AND: clauses } satisfies Prisma.EventSeriesOccurrenceWhereInput;
}

export function makeEventSeriesRepo(p: PrismaClientOrTx): EventSeriesRepo {
  return {
    async getById(seriesId) {
      const series = await p.eventSeries.findUnique({
        select: SERIES_BASE_SELECT,
        where: { id: seriesId },
      });
      return series ? mapSeries(series) : null;
    },
    async findActiveByName(ownerScope, ownerId, normalizedName) {
      const series = await p.eventSeries.findFirst({
        select: SERIES_BASE_SELECT,
        where: {
          ownerScope,
          ownerId,
          nameNormalized: normalizeName(normalizedName),
          active: true,
          archivedAt: null,
        },
      });
      return series ? mapSeries(series) : null;
    },
    async nameExists(ownerScope, ownerId, normalizedName) {
      // Deliberately does NOT filter on active/archivedAt: the unique
      // constraint (ownerScope, ownerId, nameNormalized) spans archived rows.
      const existing = await p.eventSeries.findFirst({
        select: { id: true },
        where: {
          ownerScope,
          ownerId,
          nameNormalized: normalizeName(normalizedName),
        },
      });
      return existing !== null;
    },
    async create(input) {
      const created = await p.eventSeries.create({
        select: SERIES_BASE_SELECT,
        data: {
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name.trim(),
          nameNormalized: normalizeName(input.name),
          description: input.description,
          active: true,
          timezone: input.timezone,
          schedule: input.schedule as unknown as Prisma.InputJsonValue,
          templateId: input.templateId,
          defaults: toNullableJson(input.defaults),
          createdByHumanId: input.createdByHumanId,
          updatedByHumanId: input.createdByHumanId,
          archivedAt: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies Prisma.EventSeriesUncheckedCreateInput,
      });

      return mapSeries(created);
    },
    async update(seriesId, patch) {
      const data: Prisma.EventSeriesUncheckedUpdateInput = {
        updatedByHumanId: patch.updatedByHumanId,
        updatedAt: patch.updatedAt,
      };

      if (
        Object.prototype.hasOwnProperty.call(patch, "name") &&
        patch.name !== undefined
      ) {
        data.name = patch.name.trim();
        data.nameNormalized = normalizeName(patch.name);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "description")) {
        data.description = patch.description ?? null;
      }

      if (
        Object.prototype.hasOwnProperty.call(patch, "timezone") &&
        patch.timezone !== undefined
      ) {
        data.timezone = patch.timezone;
      }

      if (
        Object.prototype.hasOwnProperty.call(patch, "schedule") &&
        patch.schedule !== undefined
      ) {
        data.schedule = patch.schedule as unknown as Prisma.InputJsonValue;
      }

      if (Object.prototype.hasOwnProperty.call(patch, "templateId")) {
        data.templateId = patch.templateId ?? null;
      }

      if (Object.prototype.hasOwnProperty.call(patch, "defaults")) {
        data.defaults = toNullableJson(patch.defaults);
      }

      if (Object.prototype.hasOwnProperty.call(patch, "active")) {
        if (typeof patch.active === "boolean") {
          data.active = patch.active;
          if (patch.active) {
            data.archivedAt = null;
          }
        }
      }

      const updated = await p.eventSeries.update({
        select: SERIES_BASE_SELECT,
        where: { id: seriesId },
        data,
      });

      return mapSeries(updated);
    },
    async archive(input) {
      const archived = await p.eventSeries.update({
        select: SERIES_BASE_SELECT,
        where: { id: input.seriesId },
        data: {
          active: false,
          archivedAt: input.archivedAt,
          updatedAt: input.archivedAt,
          updatedByHumanId: input.archivedByHumanId,
        } satisfies Prisma.EventSeriesUncheckedUpdateInput,
      });
      return mapSeries(archived);
    },
    async listByOwner(filters) {
      const baseWhere = applySeriesFilters(filters);
      const cursorData = filters.cursor
        ? parseSeriesCursor(filters.cursor)
        : null;

      const where = cursorData
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { createdAt: { lt: cursorData.createdAt } },
                  {
                    AND: [
                      { createdAt: cursorData.createdAt },
                      { id: { lt: cursorData.id } },
                    ],
                  },
                ],
              },
            ],
          }
        : baseWhere;

      const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));

      const series = await p.eventSeries.findMany({
        select: SERIES_BASE_SELECT,
        where,
        orderBy: SERIES_ORDER_BY,
        take: limit + 1,
      });

      const items = series.slice(0, limit).map(mapSeries);
      const nextSeries = series.length > limit ? series[limit] : undefined;
      const nextCursor = nextSeries ? buildSeriesCursor(nextSeries) : undefined;

      return { items, nextCursor } satisfies EventSeriesListResult;
    },
  };
}

export function makeEventSeriesOccurrencesRepo(
  p: PrismaClientOrTx,
): EventSeriesOccurrencesRepo {
  return {
    async getById(occurrenceId) {
      const occurrence = await p.eventSeriesOccurrence.findUnique({
        select: OCCURRENCE_BASE_SELECT,
        where: { id: occurrenceId },
      });
      return occurrence ? mapOccurrence(occurrence) : null;
    },
    async listBySeries(filters) {
      const baseWhere = applyOccurrenceFilters(filters);
      const cursorData = filters.cursor
        ? parseOccurrenceCursor(filters.cursor)
        : null;

      const where = cursorData
        ? {
            AND: [
              baseWhere,
              {
                OR: [
                  { startsAt: { gt: cursorData.startsAt } },
                  {
                    AND: [
                      { startsAt: cursorData.startsAt },
                      { id: { gt: cursorData.id } },
                    ],
                  },
                ],
              },
            ],
          }
        : baseWhere;

      const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));

      const occurrences = await p.eventSeriesOccurrence.findMany({
        select: OCCURRENCE_BASE_SELECT,
        where,
        orderBy: OCCURRENCE_ORDER_BY,
        take: limit + 1,
      });

      const items = occurrences.slice(0, limit).map(mapOccurrence);
      const nextOccurrence =
        occurrences.length > limit ? occurrences[limit] : undefined;
      const nextCursor = nextOccurrence
        ? buildOccurrenceCursor(nextOccurrence)
        : undefined;

      return { items, nextCursor } satisfies EventSeriesOccurrenceListResult;
    },
    async bulkUpsert(input) {
      if (!input.occurrences.length) {
        return { count: 0 };
      }

      for (const occurrence of input.occurrences) {
        await p.eventSeriesOccurrence.upsert({
          where: {
            seriesId_ordinal: {
              seriesId: occurrence.seriesId,
              ordinal: occurrence.ordinal,
            },
          },
          update: {
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt ?? null,
            status: occurrence.status,
          },
          create: {
            seriesId: occurrence.seriesId,
            ordinal: occurrence.ordinal,
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt ?? null,
            status: occurrence.status,
          },
        });
      }

      return { count: input.occurrences.length };
    },
    async bulkCreate(input) {
      if (!input.occurrences.length) {
        return { count: 0 };
      }

      try {
        const result = await p.eventSeriesOccurrence.createMany({
          data: input.occurrences.map((occurrence) => ({
            seriesId: occurrence.seriesId,
            ordinal: occurrence.ordinal,
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt ?? null,
            status: occurrence.status,
          })),
        });
        return { count: result.count };
      } catch (error) {
        // P2002 = (seriesId, ordinal) unique collision: a concurrent writer
        // (e.g. addSeriesOccurrence) allocated the same ordinal between the
        // caller's scan and this insert. Error loudly (tx rollback) instead
        // of the silent-overwrite bulkUpsert would have done.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("OCCURRENCE_ALLOCATION_CONFLICT", { cause: error });
        }
        throw error;
      }
    },
    async create(input: CreateEventSeriesOccurrenceInput) {
      try {
        const created = await p.eventSeriesOccurrence.create({
          select: OCCURRENCE_BASE_SELECT,
          data: {
            seriesId: input.seriesId,
            ordinal: input.ordinal,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            status: input.status,
            overrides: toNullableJson(input.overrides),
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
          },
        });
        return mapOccurrence(created);
      } catch (error) {
        // P2002 can only be (seriesId, ordinal) — `id` is a fresh uuid.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw fail("OCCURRENCE_ALLOCATION_CONFLICT", { cause: error });
        }
        throw error;
      }
    },
    async countBySeries(seriesId) {
      return p.eventSeriesOccurrence.count({ where: { seriesId } });
    },
    async attachEvent(input) {
      const updated = await p.eventSeriesOccurrence.update({
        select: OCCURRENCE_BASE_SELECT,
        where: { id: input.occurrenceId },
        data: {
          eventId: input.eventId,
          updatedAt: input.updatedAt,
        },
      });
      return mapOccurrence(updated);
    },
    async applyOverrides(input) {
      const updated = await p.eventSeriesOccurrence.update({
        select: OCCURRENCE_BASE_SELECT,
        where: { id: input.occurrenceId },
        data: {
          overrides: toNullableJson(input.overrides),
          updatedAt: input.updatedAt,
        },
      });
      return mapOccurrence(updated);
    },
    async markStatus(input) {
      const updated = await p.eventSeriesOccurrence.update({
        select: OCCURRENCE_BASE_SELECT,
        where: { id: input.occurrenceId },
        data: {
          status: input.status,
          updatedAt: input.updatedAt,
        },
      });
      return mapOccurrence(updated);
    },
    async markStatusIf(input) {
      // Guarded compare-and-set: the expectations live in the WHERE clause,
      // so a row changed by a concurrent writer simply doesn't match and the
      // update becomes a no-op (updated: false) instead of clobbering state.
      const result = await p.eventSeriesOccurrence.updateMany({
        where: {
          id: input.occurrenceId,
          status: input.expectStatus,
          ...(input.expectNoEvent ? { eventId: null } : {}),
        },
        data: {
          status: input.status,
          updatedAt: input.updatedAt,
        },
      });
      return { updated: result.count === 1 };
    },
    async uniqueCheck(input) {
      const clauses: Prisma.EventSeriesOccurrenceWhereInput[] = [
        { seriesId: input.seriesId },
      ];

      if (typeof input.ordinal === "number") {
        clauses.push({ ordinal: input.ordinal });
      }

      if (input.startsAt) {
        clauses.push({ startsAt: input.startsAt });
      }

      const existing = await p.eventSeriesOccurrence.findFirst({
        select: { id: true },
        where: { AND: clauses },
      });

      return !existing;
    },

    async getCalendarInfoForEventIds(eventIds) {
      if (eventIds.length === 0) return [];

      const rows = await p.eventSeriesOccurrence.findMany({
        where: { eventId: { in: eventIds } },
        select: {
          id: true,
          eventId: true,
          series: { select: { id: true, name: true } },
        },
      });

      return rows
        .filter((r): r is typeof r & { eventId: string } => r.eventId != null)
        .map((r) => ({
          eventId: r.eventId,
          seriesId: r.series.id,
          seriesName: r.series.name,
          occurrenceId: r.id,
        }));
    },

    async bulkDeletePlanned(input) {
      // Delete PLANNED occurrences for this series starting after afterDate
      // whose startsAt is NOT in the exclusion set.
      const excludeTimestamps = [...input.excludeStartsAtMs].map(
        (ms) => new Date(ms),
      );

      const where: Prisma.EventSeriesOccurrenceWhereInput = {
        seriesId: input.seriesId,
        status: "PLANNED",
        startsAt: { gt: input.afterDate },
      };

      if (excludeTimestamps.length > 0) {
        where.NOT = { startsAt: { in: excludeTimestamps } };
      }

      const result = await p.eventSeriesOccurrence.deleteMany({ where });
      return { deletedCount: result.count };
    },

    async bulkDetach(input) {
      if (input.occurrenceIds.length === 0) {
        return { detachedCount: 0 };
      }

      const result = await p.eventSeriesOccurrence.updateMany({
        where: {
          id: { in: input.occurrenceIds },
          seriesId: input.seriesId,
        },
        data: {
          status: "DETACHED",
          updatedAt: input.updatedAt,
        },
      });

      return { detachedCount: result.count };
    },

    async listBySeriesAndStatuses(seriesId, statuses, afterDate) {
      const rows = await p.eventSeriesOccurrence.findMany({
        select: OCCURRENCE_BASE_SELECT,
        where: {
          seriesId,
          status: { in: statuses },
          startsAt: { gt: afterDate },
        },
        orderBy: OCCURRENCE_ORDER_BY,
      });

      return rows.map(mapOccurrence);
    },

    async findSeriesIdByEventId(eventId) {
      const row = await p.eventSeriesOccurrence.findFirst({
        where: { eventId },
        select: {
          series: { select: { id: true, name: true } },
        },
      });

      if (!row) return null;
      return { seriesId: row.series.id, seriesName: row.series.name };
    },

    async listPublishedDatesBySeriesId(seriesId, limit) {
      const rows = await p.eventSeriesOccurrence.findMany({
        where: {
          seriesId,
          event: {
            is: {
              status: "PUBLISHED",
              visibility: "PUBLIC",
              slug: { not: null },
            },
          },
        },
        select: {
          id: true,
          event: {
            select: {
              id: true,
              slug: true,
              title: true,
              startsAt: true,
              endsAt: true,
              timezone: true,
            },
          },
        },
        orderBy: OCCURRENCE_ORDER_BY,
        take: limit,
      });

      const dates: PublicSeriesDateRecord[] = [];
      for (const row of rows) {
        const event = row.event;
        if (!event || event.slug == null) continue;
        dates.push({
          occurrenceId: row.id,
          eventId: event.id,
          slug: event.slug,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timezone: event.timezone,
        });
      }
      return dates;
    },
  };
}
