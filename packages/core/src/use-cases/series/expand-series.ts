import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  BulkUpsertEventSeriesOccurrenceRow,
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
} from "@th/types";
import { DateTime } from "luxon";
import rrulePkg from "rrule";

const { RRule } = rrulePkg;

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  dateTimeToFloating,
  floatingToInstant,
  instantToFloating,
} from "../events/_shared/rrule-floating-time";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  expandSeriesInputSchema,
  expandSeriesResultSchema,
  type ExpandSeriesInput,
  type ExpandSeriesResult,
} from "./schemas";
import { mapOccurrenceRecordToDto } from "./utils";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 60;

export type ExpandSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredExpandSeriesRecord = {
  payloadHash: string;
  response: ExpandSeriesResult;
};

export async function expandSeries(
  deps: ExpandSeriesDeps,
  rawInput: unknown,
): Promise<ExpandSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "expandSeries" });

  const execute = async () => {
    const input = parseInput(expandSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredExpandSeriesRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredExpandSeriesRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) => {
        const series = await tx.series.getById(input.seriesId);
        if (!series) {
          throw fail("SERIES_NOT_FOUND");
        }

        if (!series.active || series.archivedAt) {
          throw fail("SERIES_INACTIVE");
        }

        scopedLogger?.info?.("expanding_series_start", {
          seriesId: series.id,
          ownerScope: series.ownerScope,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          maxOccurrences: input.maxOccurrences,
        });

        await ensureSeriesOwnerAccess(
          tx,
          series.ownerScope,
          series.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const scheduleWindowStart = parseDateTime(
          series.schedule.windowStart,
          series.timezone,
        );
        const scheduleWindowEnd = parseDateTime(
          series.schedule.windowEnd,
          series.timezone,
        );
        const requestedWindowStart = parseDateTime(
          input.windowStart,
          series.timezone,
        );
        const requestedWindowEnd = parseDateTime(
          input.windowEnd,
          series.timezone,
        );

        const effectiveStart = maxDateTime(
          requestedWindowStart,
          scheduleWindowStart,
          series.schedule.kind === "RRULE"
            ? parseRequiredDateTime(
                series.schedule.dtstart,
                series.timezone,
                "dtstart",
              )
            : null,
        );

        const effectiveEnd = minDateTime(
          requestedWindowEnd,
          scheduleWindowEnd,
          series.schedule.kind === "RRULE"
            ? parseDateTime(series.schedule.until, series.timezone)
            : null,
        );

        if (!effectiveStart && !effectiveEnd) {
          throw fail("WINDOW_BOUNDS_REQUIRED");
        }

        if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
          throw fail("WINDOW_END_BEFORE_START");
        }

        const effectiveStartUtc = effectiveStart
          ? effectiveStart.toUTC().toJSDate()
          : null;
        const effectiveEndUtc = effectiveEnd
          ? effectiveEnd.toUTC().toJSDate()
          : null;
        const scheduleWindowStartUtc = scheduleWindowStart
          ? scheduleWindowStart.toUTC().toJSDate()
          : null;
        const scheduleWindowEndUtc = scheduleWindowEnd
          ? scheduleWindowEnd.toUTC().toJSDate()
          : null;

        const scheduleMax = clampNumber(
          series.schedule.maxOccurrencesPerExpand ?? 100,
          1,
          500,
        );
        const requestedMax = input.maxOccurrences
          ? clampNumber(input.maxOccurrences, 1, 500)
          : null;
        const maxCreates =
          requestedMax === null
            ? scheduleMax
            : Math.min(requestedMax, scheduleMax);

        const existingStarts = new Set<number>();
        let maxOrdinal = 0;

        await collectExistingOccurrences(
          tx,
          series.id,
          existingStarts,
          (ordinal) => {
            if (ordinal > maxOrdinal) {
              maxOrdinal = ordinal;
            }
          },
        );

        const newOccurrences = await generateOccurrences({
          tx,
          series,
          effectiveStartUtc,
          effectiveEndUtc,
          scheduleWindowStartUtc,
          scheduleWindowEndUtc,
          maxCreates,
          existingStarts,
          initialOrdinal: maxOrdinal + 1,
          logger: scopedLogger,
        });

        let occurrencesCreated = newOccurrences.length;
        if (occurrencesCreated > 0) {
          await tx.seriesOccurrences.bulkUpsert({
            occurrences: newOccurrences,
          });
        }

        const fetchedOccurrences = occurrencesCreated
          ? await fetchCreatedOccurrences(tx, series.id, newOccurrences)
          : [];

        const occurrenceDtos = fetchedOccurrences.map(mapOccurrenceRecordToDto);

        const expandedAt = deps.clock.now();

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "expanded",
          data: {
            occurrencesCreated,
            windowStart: effectiveStartUtc?.toISOString() ?? null,
            windowEnd: effectiveEndUtc?.toISOString() ?? null,
          },
          at: expandedAt,
        });

        deps.metrics?.increment("series.expanded", {
          count: occurrencesCreated.toString(),
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("expanding_series_complete", {
          seriesId: series.id,
          occurrencesCreated,
        });

        return expandSeriesResultSchema.parse({
          seriesId: series.id,
          occurrencesCreated,
          occurrences: occurrenceDtos,
        });
      });

      await deps.idempotency.commit<StoredExpandSeriesRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("expand_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("expandSeries", execute);
  }
  return execute();
}

function buildIdempotencyKey(input: ExpandSeriesInput): string {
  const windowStartKey = input.windowStart ?? "none";
  const windowEndKey = input.windowEnd ?? "none";
  return `series:expand:${input.seriesId}:${input.actorHumanId}:${input.clientKey}:${windowStartKey}:${windowEndKey}`;
}

function buildPayloadHash(input: ExpandSeriesInput): string {
  const normalized = {
    windowStart: input.windowStart ?? null,
    windowEnd: input.windowEnd ?? null,
    maxOccurrences: input.maxOccurrences ?? null,
  } satisfies Record<string, unknown>;

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function parseDateTime(
  value: string | null | undefined,
  timezone: string,
): DateTime | null {
  if (!value) {
    return null;
  }

  const dt = DateTime.fromISO(value, { zone: timezone });
  if (!dt.isValid) {
    throw fail("INVALID_DATETIME");
  }
  return dt;
}

function parseRequiredDateTime(
  value: string | null | undefined,
  timezone: string,
  field: string,
): DateTime {
  const dt = parseDateTime(value, timezone);
  if (!dt) {
    throw {
      code: "dependency_failed",
      message: `series_missing_${field}`,
    } as const;
  }
  return dt;
}

function maxDateTime(...dates: (DateTime | null)[]): DateTime | null {
  let result: DateTime | null = null;
  for (const dt of dates) {
    if (!dt) continue;
    if (!result || dt.toMillis() > result.toMillis()) {
      result = dt;
    }
  }
  return result;
}

function minDateTime(...dates: (DateTime | null)[]): DateTime | null {
  let result: DateTime | null = null;
  for (const dt of dates) {
    if (!dt) continue;
    if (!result || dt.toMillis() < result.toMillis()) {
      result = dt;
    }
  }
  return result;
}

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

async function collectExistingOccurrences(
  tx: TxRepos,
  seriesId: string,
  existingStarts: Set<number>,
  handleOrdinal: (ordinal: number) => void,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const page = await tx.seriesOccurrences.listBySeries({
      seriesId,
      limit: 200,
      cursor,
    });

    for (const occurrence of page.items) {
      existingStarts.add(occurrence.startsAt.getTime());
      handleOrdinal(occurrence.ordinal);
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

type GenerateOccurrencesParams = {
  tx: TxRepos;
  series: EventSeriesRecord;
  effectiveStartUtc: Date | null;
  effectiveEndUtc: Date | null;
  scheduleWindowStartUtc: Date | null;
  scheduleWindowEndUtc: Date | null;
  maxCreates: number;
  existingStarts: Set<number>;
  initialOrdinal: number;
  logger?: LoggerPort;
};

// TODO: converge with `events/_shared/expand-recurrence.ts` — that is the
// shared, PURE schedule→Date[] enumeration (also used by the community
// recurring-listing path). This function keeps its own inline RRULE/FIXED_DATES
// loop because it is entangled with per-row ordinal allocation, existing-
// occurrence dedup, and in-tx DB uniqueness checks; unpicking that is deferred
// so the money-bearing ticketed-series path is not destabilised. The two paths
// DO share the floating-wall-clock date arithmetic
// (`events/_shared/rrule-floating-time.ts`), which is the part that was
// silently wrong in both.
async function generateOccurrences(
  params: GenerateOccurrencesParams,
): Promise<BulkUpsertEventSeriesOccurrenceRow[]> {
  const {
    tx,
    series,
    effectiveStartUtc,
    effectiveEndUtc,
    scheduleWindowStartUtc,
    scheduleWindowEndUtc,
    maxCreates,
    existingStarts,
    initialOrdinal,
    logger,
  } = params;

  let nextOrdinal = initialOrdinal;
  const newOccurrences: BulkUpsertEventSeriesOccurrenceRow[] = [];

  const allocateOrdinal = async (startsAt: Date): Promise<number> => {
    let candidate = nextOrdinal;
    let guard = 0;
    while (true) {
      const unique = await tx.seriesOccurrences.uniqueCheck({
        seriesId: series.id,
        ordinal: candidate,
        startsAt,
      });
      if (unique) {
        nextOrdinal = candidate + 1;
        return candidate;
      }
      candidate += 1;
      guard += 1;
      if (guard > 1000) {
        logger?.error?.("series_occurrence_allocation_failed", {
          seriesId: series.id,
          startsAt: startsAt.toISOString(),
        });
        throw fail("OCCURRENCE_ALLOCATION_FAILED");
      }
    }
  };

  if (series.schedule.kind === "RRULE") {
    if (!series.schedule.rrule) {
      throw fail("SERIES_SCHEDULE_INVALID");
    }

    // `rrule` is timezone-blind: it reads/writes a Date's UTC fields and
    // treats them as FLOATING wall-clock. Driving it with real UTC instants
    // evaluates BYDAY/BYHOUR against the UTC calendar, so in a negative-offset
    // zone an evening series lands a day early on every occurrence. Everything
    // handed to or compared against the rule below lives in floating space;
    // each occurrence is converted back to a real instant before it is
    // allocated an ordinal or persisted. See
    // `events/_shared/rrule-floating-time.ts` (incl. its DST notes).
    const dtstartFloating = dateTimeToFloating(
      parseRequiredDateTime(
        series.schedule.dtstart,
        series.timezone,
        "dtstart",
      ),
    );
    if (!dtstartFloating) {
      throw fail("SERIES_SCHEDULE_INVALID");
    }
    const untilDateTime = series.schedule.until
      ? parseDateTime(series.schedule.until, series.timezone)
      : null;
    const untilFloating = untilDateTime
      ? dateTimeToFloating(untilDateTime)
      : null;

    const ruleOptions = RRule.parseString(series.schedule.rrule);
    ruleOptions.dtstart = dtstartFloating;
    if (untilFloating) {
      ruleOptions.until = untilFloating;
    }
    const rule = new RRule(ruleOptions);

    // The effective/schedule window bounds are REAL instants — project them
    // into floating space so they are comparable with `rule.after` output.
    // `maxDate`/`minDate` therefore order FLOATING values here. That is the
    // right space (the bounds gate wall-clock occurrences), with the known
    // caveat that floating and instant order can differ inside a fall-back
    // overlap hour, where one edge occurrence could fall the other side of a
    // bound.
    const searchStart = maxDate(
      instantToFloating(effectiveStartUtc, series.timezone),
      instantToFloating(scheduleWindowStartUtc, series.timezone),
      dtstartFloating,
    );
    const upperBound = minDate(
      instantToFloating(effectiveEndUtc, series.timezone),
      instantToFloating(scheduleWindowEndUtc, series.timezone),
      untilFloating,
    );

    let next = rule.after(searchStart ?? dtstartFloating, true);
    let iterations = 0;
    const maxIterations = Math.max(maxCreates * 5, maxCreates + 50);

    while (
      next &&
      newOccurrences.length < maxCreates &&
      iterations < maxIterations
    ) {
      if (upperBound && next > upperBound) {
        break;
      }

      const startsAt = floatingToInstant(next, series.timezone);
      if (startsAt) {
        const startsAtMs = startsAt.getTime();
        if (!existingStarts.has(startsAtMs)) {
          const ordinal = await allocateOrdinal(startsAt);
          newOccurrences.push({
            seriesId: series.id,
            ordinal,
            startsAt,
            endsAt: null,
            status: "PLANNED",
          });
          existingStarts.add(startsAtMs);
        }
      }

      next = rule.after(next, false);
      iterations += 1;
    }
  } else {
    const dates = series.schedule.dates ?? [];
    for (const iso of dates) {
      if (newOccurrences.length >= maxCreates) {
        break;
      }

      const dt = parseDateTime(iso, series.timezone);
      if (!dt) {
        continue;
      }

      const startsAt = dt.toUTC().toJSDate();

      if (scheduleWindowStartUtc && startsAt < scheduleWindowStartUtc) {
        continue;
      }

      if (scheduleWindowEndUtc && startsAt > scheduleWindowEndUtc) {
        continue;
      }

      if (effectiveStartUtc && startsAt < effectiveStartUtc) {
        continue;
      }

      if (effectiveEndUtc && startsAt > effectiveEndUtc) {
        continue;
      }

      const startsAtMs = startsAt.getTime();
      if (existingStarts.has(startsAtMs)) {
        continue;
      }

      const ordinal = await allocateOrdinal(startsAt);
      newOccurrences.push({
        seriesId: series.id,
        ordinal,
        startsAt,
        endsAt: null,
        status: "PLANNED",
      });
      existingStarts.add(startsAtMs);
    }
  }

  newOccurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return newOccurrences;
}

async function fetchCreatedOccurrences(
  tx: TxRepos,
  seriesId: string,
  newOccurrences: BulkUpsertEventSeriesOccurrenceRow[],
): Promise<EventSeriesOccurrenceRecord[]> {
  if (newOccurrences.length === 0) {
    return [];
  }

  const sorted = [...newOccurrences].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const range = {
    start: first.startsAt,
    end: last.startsAt,
  } as const;

  const targetStarts = new Set(sorted.map((occ) => occ.startsAt.getTime()));
  const collected: EventSeriesOccurrenceRecord[] = [];

  let cursor: string | undefined;
  do {
    const page = await tx.seriesOccurrences.listBySeries({
      seriesId,
      limit: 200,
      cursor,
      range,
    });

    collected.push(
      ...page.items.filter((occ) => targetStarts.has(occ.startsAt.getTime())),
    );
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  collected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return collected;
}

function maxDate(...dates: (Date | null)[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!result || date.getTime() > result.getTime()) {
      result = date;
    }
  }
  return result;
}

function minDate(...dates: (Date | null)[]): Date | null {
  let result: Date | null = null;
  for (const date of dates) {
    if (!date) continue;
    if (!result || date.getTime() < result.getTime()) {
      result = date;
    }
  }
  return result;
}
