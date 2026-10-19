import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";
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
import { fail } from "@th/errors";
import {
  reconcileSeriesScheduleInputSchema,
  reconcileSeriesScheduleResultSchema,
  type ReconcileSeriesScheduleInput,
  type ReconcileSeriesScheduleResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ReconcileSeriesScheduleDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredReconcileRecord = {
  payloadHash: string;
  response: ReconcileSeriesScheduleResult;
};

function buildIdempotencyKey(input: ReconcileSeriesScheduleInput): string {
  return `series:reconcile:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: ReconcileSeriesScheduleInput): string {
  const normalized = {
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    maxOccurrences: input.maxOccurrences ?? null,
    confirmedCancellations: input.confirmedCancellations
      ? [...input.confirmedCancellations].sort()
      : null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

// ── DateTime helpers (mirrored from expand-series) ──

function parseDateTime(
  value: string | null | undefined,
  timezone: string,
): DateTime | null {
  if (!value) return null;
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

/**
 * Compute the full set of occurrence startsAt timestamps (as epoch ms)
 * implied by the series schedule within the given window.
 */
function computeNewTimestamps(
  series: EventSeriesRecord,
  windowStartUtc: Date,
  windowEndUtc: Date,
  maxOccurrences: number,
): Set<number> {
  const timestamps = new Set<number>();

  if (series.schedule.kind === "RRULE") {
    if (!series.schedule.rrule) {
      throw fail("SERIES_SCHEDULE_INVALID");
    }

    // `rrule` is timezone-blind: it reads/writes a Date's UTC fields and
    // treats them as FLOATING wall-clock, so the rule must be driven in
    // wall-clock space and converted back on the way out. Driving it with
    // real UTC instants evaluates BYDAY/BYHOUR against the UTC calendar, and
    // because the returned set is matched against stored occurrence instants
    // EXACTLY, a wrong set orphans (deletes / detaches) live occurrences.
    // See `events/_shared/rrule-floating-time.ts` (incl. its DST notes).
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

    // The window bounds arrive as REAL instants — project them into floating
    // space so they are comparable with `rule.after` output.
    const windowStartFloating = instantToFloating(
      windowStartUtc,
      series.timezone,
    );
    const windowEndFloating = instantToFloating(windowEndUtc, series.timezone);
    if (!windowStartFloating || !windowEndFloating) {
      // FAIL CLOSED. Returning the empty set here would be the
      // maximum-damage value: an empty schedule orphans EVERY in-window
      // occurrence (PLANNED deleted, GENERATED/PUBLISHED detached). This is
      // unreachable today because `parseRequiredDateTime` throws on an
      // unusable timezone first — which is exactly when a fail-open default
      // is most dangerous, because nothing exercises it.
      throw fail("SERIES_SCHEDULE_INVALID");
    }

    const upperBound =
      untilFloating && untilFloating < windowEndFloating
        ? untilFloating
        : windowEndFloating;
    let next = rule.after(windowStartFloating, true);
    let count = 0;

    while (next && count < maxOccurrences) {
      if (next > upperBound) break;
      // The set is compared against stored `startsAt` values, so it must hold
      // REAL instants — convert out of floating space before adding.
      const instant = floatingToInstant(next, series.timezone);
      if (instant) {
        timestamps.add(instant.getTime());
      }
      next = rule.after(next, false);
      count++;
    }
  } else {
    // FIXED_DATES
    const dates = series.schedule.dates ?? [];
    for (const iso of dates) {
      if (timestamps.size >= maxOccurrences) break;
      const dt = parseDateTime(iso, series.timezone);
      if (!dt) continue;
      const utc = dt.toUTC().toJSDate();
      if (utc < windowStartUtc || utc > windowEndUtc) continue;
      timestamps.add(utc.getTime());
    }
  }

  return timestamps;
}

export async function reconcileSeriesSchedule(
  deps: ReconcileSeriesScheduleDeps,
  rawInput: unknown,
): Promise<ReconcileSeriesScheduleResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "reconcileSeriesSchedule",
  });

  const execute = async () => {
    const input = parseInput(reconcileSeriesScheduleInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    // ── Idempotency check ──
    const replay =
      await deps.idempotency.get<StoredReconcileRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredReconcileRecord>(idempotencyKey);
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
        // 4. Fetch series, verify access
        const series = await tx.series.getById(input.seriesId);
        if (!series) {
          throw fail("SERIES_NOT_FOUND");
        }
        if (!series.active || series.archivedAt) {
          throw fail("SERIES_INACTIVE");
        }

        await ensureSeriesOwnerAccess(
          tx,
          series.ownerScope,
          series.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        scopedLogger?.info?.("reconcile_start", {
          seriesId: series.id,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        });

        // 5. Compute the new set of timestamps from the updated schedule
        const windowStartDt = parseRequiredDateTime(
          input.windowStart,
          series.timezone,
          "windowStart",
        );
        const windowEndDt = parseRequiredDateTime(
          input.windowEnd,
          series.timezone,
          "windowEnd",
        );
        const windowStartUtc = windowStartDt.toUTC().toJSDate();
        const windowEndUtc = windowEndDt.toUTC().toJSDate();

        const scheduleMax = series.schedule.maxOccurrencesPerExpand ?? 100;
        const maxOccurrences = input.maxOccurrences
          ? Math.min(input.maxOccurrences, scheduleMax)
          : scheduleMax;

        const newTimestamps = computeNewTimestamps(
          series,
          windowStartUtc,
          windowEndUtc,
          maxOccurrences,
        );

        // 6. Fetch all existing FUTURE occurrences (startsAt > now)
        const now = deps.clock.now();
        const allStatuses: Array<
          | "PLANNED"
          | "SKIPPED"
          | "GENERATED"
          | "PUBLISHED"
          | "CANCELLED"
          | "DETACHED"
        > = [
          "PLANNED",
          "SKIPPED",
          "GENERATED",
          "PUBLISHED",
          "CANCELLED",
          "DETACHED",
        ];
        const existing = await tx.seriesOccurrences.listBySeriesAndStatuses(
          series.id,
          allStatuses,
          now,
        );

        // 7. Classify: MATCHES vs ORPHANED
        const confirmedSet = new Set(input.confirmedCancellations ?? []);
        const orphanedPlanned: EventSeriesOccurrenceRecord[] = [];
        const orphanedWithEvents: EventSeriesOccurrenceRecord[] = []; // may have orders
        let generatedKept = 0;
        let publishedKept = 0;

        for (const occ of existing) {
          // Only consider occurrences within the window
          if (occ.startsAt < windowStartUtc || occ.startsAt > windowEndUtc)
            continue;
          // Already detached/cancelled/skipped — leave alone
          if (
            occ.status === "DETACHED" ||
            occ.status === "CANCELLED" ||
            occ.status === "SKIPPED"
          )
            continue;

          // Manual one-off dates (overrides.manual, addSeriesOccurrence) are
          // off-grid by design — never classify them as orphaned. They still
          // participate in the dedupe (existingStartsMs) and ordinal scans
          // below, and the excludeSet build in 8a shields manual PLANNED rows
          // from bulkDeletePlanned.
          if (occ.overrides?.manual === true) {
            if (occ.status === "GENERATED") generatedKept++;
            if (occ.status === "PUBLISHED") publishedKept++;
            continue;
          }

          const matches = newTimestamps.has(occ.startsAt.getTime());

          if (matches) {
            if (occ.status === "GENERATED") generatedKept++;
            if (occ.status === "PUBLISHED") publishedKept++;
            continue;
          }

          // ORPHANED
          if (occ.status === "PLANNED") {
            orphanedPlanned.push(occ);
          } else if (occ.status === "GENERATED" || occ.status === "PUBLISHED") {
            // Has an event — need to check for orders to decide auto-detach vs pending
            // If no eventId, the order-check loop handles it (auto-detach, no query)
            orphanedWithEvents.push(occ);
          }
        }

        // 8a. Delete orphaned PLANNED
        const excludeSet = new Set<number>();
        // Keep any PLANNED that still matches — and any MANUAL planned row:
        // bulkDeletePlanned targets every future PLANNED not in this set, so
        // off-grid manual dates must be excluded here or they'd be deleted.
        for (const occ of existing) {
          if (
            occ.status === "PLANNED" &&
            (newTimestamps.has(occ.startsAt.getTime()) ||
              occ.overrides?.manual === true)
          ) {
            excludeSet.add(occ.startsAt.getTime());
          }
        }
        const { deletedCount: plannedRemoved } =
          await tx.seriesOccurrences.bulkDeletePlanned({
            seriesId: series.id,
            excludeStartsAtMs: excludeSet,
            afterDate: now,
          });

        // 8b. Handle orphaned GENERATED/PUBLISHED with events
        //     Query orders to decide: auto-detach (no sales) vs pendingConfirmation (has sales)
        const toAutoDetach: string[] = [];
        const pendingConfirmation: ReconcileSeriesScheduleResult["published"]["pendingConfirmation"] =
          [];
        let publishedDetached = 0;
        let generatedDetached = 0;

        for (const occ of orphanedWithEvents) {
          if (!occ.eventId) {
            // No event attached — treat like PLANNED, auto-detach
            toAutoDetach.push(occ.id);
            if (occ.status === "PUBLISHED") publishedDetached++;
            else generatedDetached++;
            continue;
          }

          // Query active orders for this event (SUCCEEDED or PROCESSING)
          const orderResult = await tx.orders.listAll({
            eventId: occ.eventId,
            statuses: ["SUCCEEDED", "PROCESSING"],
            limit: 1, // only need the total count, not the items
          });
          const orderCount = orderResult.total;

          if (orderCount === 0) {
            // No sales — safe to auto-detach without confirmation
            toAutoDetach.push(occ.id);
            if (occ.status === "PUBLISHED") publishedDetached++;
            else generatedDetached++;
          } else if (confirmedSet.has(occ.id)) {
            // Organizer explicitly confirmed detachment of this occurrence
            toAutoDetach.push(occ.id);
            if (occ.status === "PUBLISHED") publishedDetached++;
            else generatedDetached++;
          } else {
            // Has sales, NOT yet confirmed — add to pendingConfirmation
            // Fetch event title for the UI dialog
            const event = await tx.events.getById(occ.eventId);
            pendingConfirmation.push({
              occurrenceId: occ.id,
              eventId: occ.eventId,
              eventTitle: event?.title ?? "Untitled Event",
              startsAt: occ.startsAt.toISOString(),
              deferredOrderCount: 0, // deferred capture not yet implemented
              capturedOrderCount: orderCount,
            });
          }
        }

        if (toAutoDetach.length > 0) {
          await tx.seriesOccurrences.bulkDetach({
            seriesId: series.id,
            occurrenceIds: toAutoDetach,
            updatedAt: now,
          });
        }

        // 9. Insert new PLANNED occurrences for timestamps that don't have one
        const existingStartsMs = new Set(
          existing.map((o) => o.startsAt.getTime()),
        );
        const toInsert: BulkUpsertEventSeriesOccurrenceRow[] = [];
        // Ordinal allocation must span ALL occurrences, not just the FUTURE
        // ones `existing` holds (afterDate = now): (seriesId, ordinal) is
        // unique, so re-allocating a PAST occurrence's ordinal collides.
        // The insert below is CREATE-ONLY (bulkCreate) — a collision (e.g. a
        // concurrent addSeriesOccurrence allocating the same ordinal) throws
        // OCCURRENCE_ALLOCATION_CONFLICT and rolls the tx back, instead of
        // bulkUpsert's silent UPDATE overwriting the existing row.
        const allOccurrences =
          await tx.seriesOccurrences.listBySeriesAndStatuses(
            series.id,
            allStatuses,
            new Date(0),
          );
        let maxOrdinal = 0;
        for (const occ of allOccurrences) {
          if (occ.ordinal > maxOrdinal) maxOrdinal = occ.ordinal;
        }

        for (const tsMs of newTimestamps) {
          if (existingStartsMs.has(tsMs)) continue;
          maxOrdinal++;
          toInsert.push({
            seriesId: series.id,
            ordinal: maxOrdinal,
            startsAt: new Date(tsMs),
            endsAt: null,
            status: "PLANNED",
          });
        }

        let plannedAdded = 0;
        if (toInsert.length > 0) {
          toInsert.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
          await tx.seriesOccurrences.bulkCreate({ occurrences: toInsert });
          plannedAdded = toInsert.length;
        }

        // 10. Audit log
        const reconcileResult: ReconcileSeriesScheduleResult = {
          seriesId: series.id,
          planned: {
            added: plannedAdded,
            removed: plannedRemoved,
          },
          generated: {
            detached: generatedDetached,
            kept: generatedKept,
          },
          published: {
            detached: publishedDetached,
            kept: publishedKept,
            pendingConfirmation,
          },
        };

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "reconciled",
          data: {
            planned: reconcileResult.planned,
            generated: reconcileResult.generated,
            published: {
              detached: reconcileResult.published.detached,
              kept: reconcileResult.published.kept,
              pendingCount:
                reconcileResult.published.pendingConfirmation.length,
            },
          },
          at: now,
        });

        deps.metrics?.increment("series.reconciled", {
          ownerScope: series.ownerScope,
          plannedAdded: String(plannedAdded),
          plannedRemoved: String(plannedRemoved),
        });

        scopedLogger?.info?.("reconcile_complete", {
          seriesId: series.id,
          plannedAdded,
          plannedRemoved,
          generatedDetached,
          publishedDetached,
        });

        return reconcileSeriesScheduleResultSchema.parse(reconcileResult);
      });

      await deps.idempotency.commit<StoredReconcileRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("reconcile_series_schedule", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reconcileSeriesSchedule", execute);
  }
  return execute();
}
