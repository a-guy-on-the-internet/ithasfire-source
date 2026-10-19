import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import {
  updateApplicationFormTemplateInputSchema,
  updateApplicationFormTemplateResultSchema,
  type UpdateApplicationFormTemplateInput,
  type UpdateApplicationFormTemplateResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type UpdateApplicationFormTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredUpdateResult {
  payloadHash: string;
  response: UpdateApplicationFormTemplateResult;
}

function buildPayloadHash(input: UpdateApplicationFormTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Rename / re-describe / re-author an OWNED template.
 *
 * Fork-on-use (spec D4) is what makes this safe to allow at all: no event form
 * points at a template, so editing one can never mutate a form that already
 * shipped. Nothing is versioned here for the same reason.
 */
export async function updateApplicationFormTemplate(
  deps: UpdateApplicationFormTemplateDeps,
  rawInput: unknown,
): Promise<UpdateApplicationFormTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "updateApplicationFormTemplate",
  });

  const execute = async () => {
    const input = parseInput(updateApplicationFormTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:update:${input.templateId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredUpdateResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredUpdateResult>(idempotencyKey);
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
        const template = await tx.applicationFormTemplates.getById(
          input.templateId,
        );
        if (!template) {
          throw fail("TEMPLATE_NOT_FOUND");
        }

        // Platform catalogue rows are read-only to organizers. Rejected
        // BEFORE any owner-access check — a null `ownerId` leaves "who owns
        // this" unanswerable on a row anyone can name by id — and with the
        // SAME TEMPLATE_NOT_FOUND a foreign template gets, so the response
        // confirms nothing. `isPlatform` and `ownerId === null` are tested
        // separately on purpose: a mis-shaped row fails closed either way.
        if (template.isPlatform || template.ownerId === null) {
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

        if (template.archivedAt) {
          throw fail("TEMPLATE_ARCHIVED");
        }

        // Rename collision, same courtesy pre-check as create. Skipped when
        // the name is unchanged (case-insensitively) so re-saving a template
        // without touching its name never collides with itself.
        if (
          input.name !== undefined &&
          input.name.toLowerCase() !== template.name.toLowerCase()
        ) {
          const clash = await tx.applicationFormTemplates.findByName(
            template.ownerScope,
            template.ownerId,
            input.name,
          );
          if (clash && clash.id !== template.id) {
            throw fail("TEMPLATE_NAME_TAKEN");
          }
        }

        const now = deps.clock.now();
        const updated = await tx.applicationFormTemplates.update({
          templateId: template.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.introText !== undefined
            ? { introText: input.introText }
            : {}),
          ...(input.questions !== undefined
            ? { questions: input.questions }
            : {}),
          updatedAt: now,
        });

        await tx.audit.log({
          entity: "application_form_template",
          entityId: updated.id,
          action: "updated",
          data: {
            ownerScope: updated.ownerScope,
            ownerId: updated.ownerId,
            actorHumanId: input.actorHumanId,
            fields: Object.keys(input).filter(
              (key) =>
                key !== "actorHumanId" &&
                key !== "templateId" &&
                key !== "clientKey",
            ),
            questionCount: updated.questions.length,
          },
          at: now,
        });

        return updateApplicationFormTemplateResultSchema.parse({
          templateId: updated.id,
          name: updated.name,
        });
      });

      await deps.idempotency.commit<StoredUpdateResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("update_application_form_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("updateApplicationFormTemplate", execute);
  }

  return execute();
}
