import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  updateEventTemplateInputSchema,
  updateEventTemplateResultSchema,
  type UpdateEventTemplateInput,
  type UpdateEventTemplateResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "./permissions";
import { fail } from "@th/errors";
import { guardPayoutTermsDraftWrite } from "../../lib/event-edit-rights";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type UpdateEventTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredUpdateTemplateResult {
  payloadHash: string;
  response: UpdateEventTemplateResult;
}

function buildPayloadHash(input: UpdateEventTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function updateEventTemplate(
  deps: UpdateEventTemplateDeps,
  rawInput: unknown,
): Promise<UpdateEventTemplateResult> {
  const scopedLogger = deps.logger?.child({ useCase: "updateEventTemplate" });

  const execute = async () => {
    const input = parseInput(updateEventTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `event-template:update:${input.templateId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredUpdateTemplateResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredUpdateTemplateResult>(idempotencyKey);
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
        const template = await tx.eventTemplates.getById(input.templateId);
        if (!template) {
          throw fail("TEMPLATE_NOT_FOUND");
        }

        await ensureTemplateOwnerAccess(
          tx,
          template.ownerScope,
          template.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const isArchived = template.archivedAt !== null;
        const wantsReactivate =
          Object.prototype.hasOwnProperty.call(input.patch, "active") &&
          input.patch.active === true;
        if (isArchived && !wantsReactivate) {
          throw fail("TEMPLATE_ARCHIVED");
        }

        if (
          Object.prototype.hasOwnProperty.call(input.patch, "name") &&
          input.patch.name !== undefined &&
          input.patch.name.toLowerCase() !== template.name.toLowerCase()
        ) {
          const conflict = await tx.eventTemplates.findByName(
            template.ownerScope,
            template.ownerId,
            input.patch.name,
          );
          if (conflict && conflict.id !== template.id) {
            throw fail("TEMPLATE_NAME_TAKEN");
          }
        }

        const now = deps.clock.now();
        const repoPatch: Parameters<typeof tx.eventTemplates.update>[1] = {
          updatedByHumanId: input.actorHumanId,
          updatedAt: now,
        };

        const changedFields: string[] = [];

        if (
          Object.prototype.hasOwnProperty.call(input.patch, "name") &&
          input.patch.name !== undefined
        ) {
          repoPatch.name = input.patch.name;
          changedFields.push("name");
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "description")) {
          repoPatch.description = input.patch.description ?? null;
          changedFields.push("description");
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "defaults")) {
          // PAYOUT ROUTING: a delegate's defaults save may not write payout
          // terms, and keeps whatever the owner stored (owner ruling
          // 2026-09-28).
          repoPatch.defaults =
            guardPayoutTermsDraftWrite({
              ownerScope: template.ownerScope,
              ownerId: template.ownerId,
              actorHumanId: input.actorHumanId,
              incoming: input.patch.defaults,
              stored: template.defaults,
            }) ?? null;
          changedFields.push("defaults");
        }
        if (Object.prototype.hasOwnProperty.call(input.patch, "active")) {
          if (typeof input.patch.active === "boolean") {
            repoPatch.active = input.patch.active;
            changedFields.push("active");
          }
        }

        const updated = await tx.eventTemplates.update(template.id, repoPatch);

        await tx.audit.log({
          entity: "event_template",
          entityId: template.id,
          action: "updated",
          data: {
            changedFields,
            active: updated.active,
          },
          at: now,
        });

        return updateEventTemplateResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredUpdateTemplateResult>(
        idempotencyKey,
        {
          payloadHash,
          response: result,
        },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("update_event_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateEventTemplate", execute);
  }

  return execute();
}
