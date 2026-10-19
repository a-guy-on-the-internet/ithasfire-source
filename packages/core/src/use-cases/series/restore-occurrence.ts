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
  restoreOccurrenceInputSchema,
  restoreOccurrenceResultSchema,
  type RestoreOccurrenceInput,
  type RestoreOccurrenceResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type RestoreOccurrenceDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredRestoreRecord = {
  payloadHash: string;
  response: RestoreOccurrenceResult;
};

function buildIdempotencyKey(input: RestoreOccurrenceInput): string {
  return `series:restore-occurrence:${input.seriesId}:${input.occurrenceId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: RestoreOccurrenceInput): string {
  const normalized = {
    seriesId: input.seriesId,
    occurrenceId: input.occurrenceId,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Restore a SKIPPED occurrence: SKIPPED → PLANNED, clearing
 * `overrides.skipNote` while preserving every other overrides key. Only a
 * SKIPPED occurrence may be restored.
 */
export async function restoreOccurrence(
  deps: RestoreOccurrenceDeps,
  rawInput: unknown,
): Promise<RestoreOccurrenceResult> {
  const scopedLogger = deps.logger?.child({ useCase: "restoreOccurrence" });

  const execute = async () => {
    const input = parseInput(restoreOccurrenceInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredRestoreRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredRestoreRecord>(idempotencyKey);
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
        if (occurrence.status !== "SKIPPED") {
          throw fail("OCCURRENCE_NOT_SKIPPED", {
            meta: { status: occurrence.status },
          });
        }

        const now = deps.clock.now();

        // Guarded conditional transition: only a row still SKIPPED at write
        // time transitions. A concurrent writer that changed it makes this a
        // no-op → typed conflict, tx rollback.
        const { updated } = await tx.seriesOccurrences.markStatusIf({
          occurrenceId: occurrence.id,
          expectStatus: "SKIPPED",
          status: "PLANNED",
          updatedAt: now,
        });
        if (!updated) {
          throw fail("OCCURRENCE_NOT_SKIPPED", {
            meta: { reason: "concurrent_transition" },
          });
        }

        // Clear skipNote, preserve the rest. Collapse to null when nothing
        // remains so the row goes back to a clean `overrides: null`. Runs
        // AFTER the guarded transition so a lost race rolls back together.
        if (occurrence.overrides) {
          const { skipNote: _cleared, ...rest } = occurrence.overrides;
          const remaining = rest as EventSeriesOccurrenceOverrides;
          const hasRemaining = Object.values(remaining).some(
            (value) => value !== undefined && value !== null,
          );
          await tx.seriesOccurrences.applyOverrides({
            occurrenceId: occurrence.id,
            overrides: hasRemaining ? remaining : null,
            updatedAt: now,
          });
        }

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "occurrence_restored",
          data: {
            occurrenceId: occurrence.id,
            startsAt: occurrence.startsAt.toISOString(),
          },
          at: now,
        });

        deps.metrics?.increment("series.occurrence_restored", {
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("restore_occurrence_complete", {
          seriesId: series.id,
          occurrenceId: occurrence.id,
        });

        return restoreOccurrenceResultSchema.parse({
          occurrenceId: occurrence.id,
          status: "PLANNED",
        });
      });

      await deps.idempotency.commit<StoredRestoreRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("restore_occurrence", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("restoreOccurrence", execute);
  }
  return execute();
}
