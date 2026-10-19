import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";
import type { EventSeriesOccurrenceOverrides } from "@th/types";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureSeriesOwnerAccess } from "./permissions";
import { fail } from "@th/errors";
import {
  skipOccurrenceInputSchema,
  skipOccurrenceResultSchema,
  type SkipOccurrenceInput,
  type SkipOccurrenceResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type SkipOccurrenceDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredSkipRecord = {
  payloadHash: string;
  response: SkipOccurrenceResult;
};

function buildIdempotencyKey(input: SkipOccurrenceInput): string {
  return `series:skip-occurrence:${input.seriesId}:${input.occurrenceId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: SkipOccurrenceInput): string {
  const normalized = {
    seriesId: input.seriesId,
    occurrenceId: input.occurrenceId,
    note: input.note ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Skip a PLANNED occurrence: PLANNED → SKIPPED with the organizer's note in
 * `overrides.skipNote` (other overrides keys preserved).
 *
 * Only a PLANNED occurrence with NO linked event may be skipped — anything
 * else (GENERATED/PUBLISHED/CANCELLED/DETACHED, or a stray PLANNED with an
 * eventId) must go through cancel/detach flows instead. SKIPPED occurrences
 * are excluded from generateEventsFromSeries (PLANNED-only) and from
 * reconcileSeriesSchedule's orphan handling.
 */
export async function skipOccurrence(
  deps: SkipOccurrenceDeps,
  rawInput: unknown,
): Promise<SkipOccurrenceResult> {
  const scopedLogger = deps.logger?.child({ useCase: "skipOccurrence" });

  const execute = async () => {
    const input = parseInput(skipOccurrenceInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay = await deps.idempotency.get<StoredSkipRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredSkipRecord>(idempotencyKey);
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

        const occurrence = await tx.seriesOccurrences.getById(
          input.occurrenceId,
        );
        if (!occurrence || occurrence.seriesId !== series.id) {
          throw fail("OCCURRENCE_NOT_FOUND");
        }
        // Friendly early error — the guarded write below is the real gate.
        if (occurrence.status !== "PLANNED" || occurrence.eventId) {
          throw fail("OCCURRENCE_NOT_SKIPPABLE", {
            meta: { status: occurrence.status, hasEvent: !!occurrence.eventId },
          });
        }

        const now = deps.clock.now();

        // Guarded conditional transition: a concurrent generate can attach an
        // event between the read above and this write. The expectations ride
        // in the UPDATE's WHERE clause, so the race loser gets updated: false
        // (→ typed conflict, tx rollback) instead of a SKIPPED-with-event row.
        const { updated } = await tx.seriesOccurrences.markStatusIf({
          occurrenceId: occurrence.id,
          expectStatus: "PLANNED",
          expectNoEvent: true,
          status: "SKIPPED",
          updatedAt: now,
        });
        if (!updated) {
          throw fail("OCCURRENCE_NOT_SKIPPABLE", {
            meta: { reason: "concurrent_transition" },
          });
        }

        // Preserve every other overrides key; only stamp skipNote (when a
        // note was provided and survived sanitization). Runs AFTER the
        // guarded transition so a lost race rolls everything back together.
        const note = input.note?.length ? input.note : undefined;
        if (note !== undefined || occurrence.overrides) {
          const overrides: EventSeriesOccurrenceOverrides = {
            ...(occurrence.overrides ?? {}),
            ...(note !== undefined ? { skipNote: note } : {}),
          };
          await tx.seriesOccurrences.applyOverrides({
            occurrenceId: occurrence.id,
            overrides,
            updatedAt: now,
          });
        }

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "occurrence_skipped",
          data: {
            occurrenceId: occurrence.id,
            startsAt: occurrence.startsAt.toISOString(),
            hasNote: note !== undefined,
          },
          at: now,
        });

        deps.metrics?.increment("series.occurrence_skipped", {
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("skip_occurrence_complete", {
          seriesId: series.id,
          occurrenceId: occurrence.id,
        });

        return skipOccurrenceResultSchema.parse({
          occurrenceId: occurrence.id,
          status: "SKIPPED",
        });
      });

      await deps.idempotency.commit<StoredSkipRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("skip_occurrence", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("skipOccurrence", execute);
  }
  return execute();
}
