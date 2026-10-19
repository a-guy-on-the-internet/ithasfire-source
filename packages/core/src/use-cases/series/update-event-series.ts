import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  type UpdateEventSeriesInput,
  type UpdateEventSeriesResult,
  updateEventSeriesInputSchema,
  updateEventSeriesResultSchema,
} from "./schemas";
import { normalizeDefaults, normalizeSchedule } from "./utils";
import { fail } from "@th/errors";
import { guardPayoutTermsDraftWrite } from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type UpdateEventSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredUpdateSeriesRecord = {
  payloadHash: string;
  response: UpdateEventSeriesResult;
};

function buildPayloadHash(input: UpdateEventSeriesInput): string {
  const normalized = {
    seriesId: input.seriesId,
    patch: {
      ...input.patch,
      defaults: Object.prototype.hasOwnProperty.call(input.patch, "defaults")
        ? normalizeDefaults(input.patch.defaults)
        : undefined,
      schedule: input.patch.schedule
        ? normalizeSchedule(input.patch.schedule)
        : undefined,
    },
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function buildIdempotencyKey(input: UpdateEventSeriesInput): string {
  return `series:update:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

export async function updateEventSeries(
  deps: UpdateEventSeriesDeps,
  rawInput: unknown,
): Promise<UpdateEventSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "updateEventSeries" });

  const execute = async () => {
    const input = parseInput(updateEventSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredUpdateSeriesRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredUpdateSeriesRecord>(idempotencyKey);
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

        if (
          Object.prototype.hasOwnProperty.call(input.patch, "name") &&
          input.patch.name
        ) {
          const normalizedName = input.patch.name.trim().toLowerCase();
          if (normalizedName !== series.name.trim().toLowerCase()) {
            const existing = await tx.series.findActiveByName(
              series.ownerScope,
              series.ownerId,
              normalizedName,
            );
            if (existing && existing.id !== series.id) {
              throw fail("SERIES_NAME_TAKEN");
            }
          }
        }

        if (Object.prototype.hasOwnProperty.call(input.patch, "templateId")) {
          if (input.patch.templateId) {
            const template = await tx.eventTemplates.getById(
              input.patch.templateId,
            );
            if (
              !template ||
              template.ownerScope !== series.ownerScope ||
              template.ownerId !== series.ownerId
            ) {
              throw fail("TEMPLATE_NOT_FOUND");
            }
            if (!template.active || template.archivedAt) {
              throw fail("TEMPLATE_NOT_ACTIVE");
            }
          }
        }

        const schedule = Object.prototype.hasOwnProperty.call(
          input.patch,
          "schedule",
        )
          ? normalizeSchedule(input.patch.schedule!)
          : undefined;
        const defaults = Object.prototype.hasOwnProperty.call(
          input.patch,
          "defaults",
        )
          ? // PAYOUT ROUTING: a delegate's defaults save may not write payout
            // terms, and keeps whatever the owner stored (owner ruling
            // 2026-09-28).
            (guardPayoutTermsDraftWrite({
              ownerScope: series.ownerScope,
              ownerId: series.ownerId,
              actorHumanId: input.actorHumanId,
              incoming: normalizeDefaults(input.patch.defaults),
              stored: series.defaults,
            }) ?? null)
          : undefined;

        const repoPatch = {
          updatedByHumanId: input.actorHumanId,
          updatedAt: deps.clock.now(),
        } as const;

        const data: Parameters<typeof tx.series.update>[1] = {
          ...repoPatch,
        };

        if (Object.prototype.hasOwnProperty.call(input.patch, "name")) {
          data.name = input.patch.name?.trim();
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "description")) {
          const description = input.patch.description;
          data.description =
            description === null ? null : (description?.trim() ?? null);
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "timezone")) {
          data.timezone = input.patch.timezone;
        }
        if (schedule) {
          data.schedule = schedule;
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "templateId")) {
          data.templateId = input.patch.templateId ?? null;
        }
        if (defaults !== undefined) {
          data.defaults = defaults;
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "active")) {
          data.active = input.patch.active;
        }

        await tx.series.update(series.id, data);

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "updated",
          data: {
            fields: Object.keys(input.patch),
          },
          at: data.updatedAt,
        });

        deps.metrics?.increment("series.updated", {
          ownerScope: series.ownerScope,
        });

        return updateEventSeriesResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredUpdateSeriesRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("update_event_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateEventSeries", execute);
  }

  return execute();
}
