import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  createEventTemplateInputSchema,
  createEventTemplateResultSchema,
  type CreateEventTemplateInput,
  type CreateEventTemplateResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "./permissions";
import { fail } from "@th/errors";
import { guardPayoutTermsDraftWrite } from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type CreateEventTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredCreateTemplateResult {
  payloadHash: string;
  response: CreateEventTemplateResult;
}

function buildPayloadHash(input: CreateEventTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function createEventTemplate(
  deps: CreateEventTemplateDeps,
  rawInput: unknown,
): Promise<CreateEventTemplateResult> {
  const scopedLogger = deps.logger?.child({ useCase: "createEventTemplate" });

  const execute = async () => {
    const input = parseInput(createEventTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `event-template:create:${input.ownerScope}:${input.ownerId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredCreateTemplateResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredCreateTemplateResult>(idempotencyKey);
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
        await ensureTemplateOwnerAccess(
          tx,
          input.ownerScope,
          input.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const existing = await tx.eventTemplates.findByName(
          input.ownerScope,
          input.ownerId,
          input.name,
        );
        if (existing) {
          throw fail("TEMPLATE_NAME_TAKEN");
        }

        const now = deps.clock.now();
        const created = await tx.eventTemplates.create({
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description ?? null,
          // PAYOUT ROUTING: a delegate may not seed payout terms into the
          // principal's template (owner ruling 2026-09-28).
          defaults:
            guardPayoutTermsDraftWrite({
              ownerScope: input.ownerScope,
              ownerId: input.ownerId,
              actorHumanId: input.actorHumanId,
              incoming: input.defaults,
              stored: null,
            }) ?? null,
          active: true,
          createdByHumanId: input.actorHumanId,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "event_template",
          entityId: created.id,
          action: "created",
          data: {
            ownerScope: created.ownerScope,
            ownerId: created.ownerId,
          },
          at: now,
        });

        return createEventTemplateResultSchema.parse({
          templateId: created.id,
        });
      });

      await deps.idempotency.commit<StoredCreateTemplateResult>(
        idempotencyKey,
        {
          payloadHash,
          response: result,
        },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("create_event_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createEventTemplate", execute);
  }

  return execute();
}
