import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureSeriesOwnerAccess } from "./permissions";
import { fail } from "@th/errors";
import {
  archiveEventSeriesInputSchema,
  archiveEventSeriesResultSchema,
  type ArchiveEventSeriesInput,
  type ArchiveEventSeriesResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ArchiveEventSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

type StoredArchiveSeriesRecord = {
  payloadHash: string;
  response: ArchiveEventSeriesResult;
};

function buildIdempotencyKey(input: ArchiveEventSeriesInput): string {
  return `series:archive:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

export async function archiveEventSeries(
  deps: ArchiveEventSeriesDeps,
  rawInput: unknown,
): Promise<ArchiveEventSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "archiveEventSeries" });

  const execute = async () => {
    const input = parseInput(archiveEventSeriesInputSchema, rawInput);
    const payloadHash = input.seriesId;
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredArchiveSeriesRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredArchiveSeriesRecord>(idempotencyKey);
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

        await ensureSeriesOwnerAccess(
          tx,
          series.ownerScope,
          series.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        if (!series.active && series.archivedAt) {
          return archiveEventSeriesResultSchema.parse({ ok: true });
        }

        const archivedAt = deps.clock.now();
        await tx.series.archive({
          seriesId: series.id,
          archivedAt,
          archivedByHumanId: input.actorHumanId,
        });

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "archived",
          data: {
            ownerScope: series.ownerScope,
            ownerId: series.ownerId,
          },
          at: archivedAt,
        });

        return archiveEventSeriesResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredArchiveSeriesRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("archive_event_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("archiveEventSeries", execute);
  }

  return execute();
}
