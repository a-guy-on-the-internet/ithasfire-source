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
  createEventSeriesInputSchema,
  createEventSeriesResultSchema,
  type CreateEventSeriesInput,
  type CreateEventSeriesResult,
} from "./schemas";
import { normalizeDefaults, normalizeSchedule } from "./utils";
import { fail } from "@th/errors";
import { guardPayoutTermsDraftWrite } from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type CreateEventSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredCreateSeriesRecord = {
  payloadHash: string;
  response: CreateEventSeriesResult;
};

function buildPayloadHash(input: CreateEventSeriesInput): string {
  const normalized = {
    ownerScope: input.ownerScope,
    ownerId: input.ownerId,
    name: input.name.trim(),
    description: input.description ?? null,
    timezone: input.timezone,
    schedule: normalizeSchedule(input.schedule),
    templateId: input.templateId ?? null,
    defaults: normalizeDefaults(input.defaults),
  };

  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function buildIdempotencyKey(input: CreateEventSeriesInput): string {
  return `series:create:${input.actorHumanId}:${input.ownerScope}:${input.ownerId}`;
}

export async function createEventSeries(
  deps: CreateEventSeriesDeps,
  rawInput: unknown,
): Promise<CreateEventSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "createEventSeries" });

  const execute = async () => {
    const input = parseInput(createEventSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `${buildIdempotencyKey(input)}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredCreateSeriesRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredCreateSeriesRecord>(idempotencyKey);
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
        await ensureSeriesOwnerAccess(
          tx,
          input.ownerScope,
          input.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const normalizedName = input.name.trim().toLowerCase();
        const existing = await tx.series.findActiveByName(
          input.ownerScope,
          input.ownerId,
          normalizedName,
        );
        if (existing) {
          throw fail("SERIES_NAME_TAKEN");
        }

        if (input.templateId) {
          const template = await tx.eventTemplates.getById(input.templateId);
          if (
            !template ||
            template.ownerScope !== input.ownerScope ||
            template.ownerId !== input.ownerId
          ) {
            throw fail("TEMPLATE_NOT_FOUND");
          }
          if (!template.active || template.archivedAt) {
            throw fail("TEMPLATE_NOT_ACTIVE");
          }
        }

        const schedule = normalizeSchedule(input.schedule);
        // PAYOUT ROUTING: a delegate may not seed payout terms into the
        // principal's series defaults (owner ruling 2026-09-28).
        const defaults =
          guardPayoutTermsDraftWrite({
            ownerScope: input.ownerScope,
            ownerId: input.ownerId,
            actorHumanId: input.actorHumanId,
            incoming: normalizeDefaults(input.defaults),
            stored: null,
          }) ?? null;
        const now = deps.clock.now();

        const created = await tx.series.create({
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name.trim(),
          description: input.description?.trim() ?? null,
          timezone: input.timezone,
          schedule,
          templateId: input.templateId ?? null,
          defaults,
          createdByHumanId: input.actorHumanId,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "event_series",
          entityId: created.id,
          action: "created",
          data: {
            ownerScope: created.ownerScope,
            ownerId: created.ownerId,
            templateId: created.templateId,
          },
          at: now,
        });

        deps.metrics?.increment("series.created", {
          count: "1",
          ownerScope: input.ownerScope,
        });

        return createEventSeriesResultSchema.parse({ seriesId: created.id });
      });

      await deps.idempotency.commit<StoredCreateSeriesRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("create_event_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createEventSeries", execute);
  }

  return execute();
}
