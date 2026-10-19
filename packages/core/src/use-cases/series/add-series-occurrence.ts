import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";
import type {
  EventSeriesOccurrenceOverrides,
  EventSeriesOccurrenceStatus,
} from "@th/types";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureSeriesOwnerAccess } from "./permissions";
import { fail } from "@th/errors";
import {
  addSeriesOccurrenceInputSchema,
  addSeriesOccurrenceResultSchema,
  type AddSeriesOccurrenceInput,
  type AddSeriesOccurrenceResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

const ALL_STATUSES: EventSeriesOccurrenceStatus[] = [
  "PLANNED",
  "SKIPPED",
  "GENERATED",
  "PUBLISHED",
  "CANCELLED",
  "DETACHED",
];

export type AddSeriesOccurrenceDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredAddRecord = {
  payloadHash: string;
  response: AddSeriesOccurrenceResult;
};

function buildIdempotencyKey(input: AddSeriesOccurrenceInput): string {
  return `series:add-occurrence:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: AddSeriesOccurrenceInput): string {
  const normalized = {
    seriesId: input.seriesId,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? null,
    note: input.note ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Insert a manual one-off date into a series: a PLANNED occurrence with
 * `overrides.manual = true`. Manual occurrences are off-grid by design —
 * reconcileSeriesSchedule never classifies them as orphaned, but they remain
 * fully generate-able (they're just PLANNED) and participate in dedupe /
 * ordinal allocation like any other occurrence.
 *
 * Ordinal allocation spans ALL statuses (not just future rows) — bulkUpsert
 * keys on (seriesId, ordinal), so reusing a past occurrence's ordinal would
 * silently overwrite that row (same trap reconcile's round-2 fix closed).
 */
export async function addSeriesOccurrence(
  deps: AddSeriesOccurrenceDeps,
  rawInput: unknown,
): Promise<AddSeriesOccurrenceResult> {
  const scopedLogger = deps.logger?.child({ useCase: "addSeriesOccurrence" });

  const execute = async () => {
    const input = parseInput(addSeriesOccurrenceInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay = await deps.idempotency.get<StoredAddRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredAddRecord>(idempotencyKey);
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

        await ensureSeriesOwnerAccess(
          tx,
          series.ownerScope,
          series.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const now = deps.clock.now();
        const startsAt = new Date(input.startsAt);
        if (startsAt.getTime() <= now.getTime()) {
          throw fail("EVENT_DATE_IN_PAST");
        }
        const endsAt = input.endsAt ? new Date(input.endsAt) : null;

        // Scan ALL occurrences (all statuses, from epoch): dedupe on startsAt
        // and allocate ordinal = max + 1.
        const allOccurrences =
          await tx.seriesOccurrences.listBySeriesAndStatuses(
            series.id,
            ALL_STATUSES,
            new Date(0),
          );
        let maxOrdinal = 0;
        for (const occ of allOccurrences) {
          if (occ.startsAt.getTime() === startsAt.getTime()) {
            throw fail("OCCURRENCE_DUPLICATE_DATE", {
              meta: { startsAt: startsAt.toISOString() },
            });
          }
          if (occ.ordinal > maxOrdinal) maxOrdinal = occ.ordinal;
        }

        const note = input.note?.length ? input.note : undefined;
        const overrides: EventSeriesOccurrenceOverrides = {
          manual: true,
          ...(note !== undefined ? { note } : {}),
        };

        const created = await tx.seriesOccurrences.create({
          seriesId: series.id,
          ordinal: maxOrdinal + 1,
          startsAt,
          endsAt,
          status: "PLANNED",
          overrides,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "occurrence_added",
          data: {
            occurrenceId: created.id,
            ordinal: created.ordinal,
            startsAt: startsAt.toISOString(),
            manual: true,
          },
          at: now,
        });

        deps.metrics?.increment("series.occurrence_added", {
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("add_series_occurrence_complete", {
          seriesId: series.id,
          occurrenceId: created.id,
          ordinal: created.ordinal,
        });

        return addSeriesOccurrenceResultSchema.parse({
          occurrenceId: created.id,
        });
      });

      await deps.idempotency.commit<StoredAddRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("add_series_occurrence", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("addSeriesOccurrence", execute);
  }
  return execute();
}
