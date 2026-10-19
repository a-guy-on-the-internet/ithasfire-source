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
  createApplicationFormTemplateInputSchema,
  createApplicationFormTemplateResultSchema,
  type CreateApplicationFormTemplateInput,
  type CreateApplicationFormTemplateResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type CreateApplicationFormTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredCreateResult {
  payloadHash: string;
  response: CreateApplicationFormTemplateResult;
}

function buildPayloadHash(input: CreateApplicationFormTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Create an owner-scoped application-form template from scratch (the template
 * editor's "New template"). `save-form-as-template` is the other producer; it
 * shares this shape but sources its questions from a live event form.
 */
export async function createApplicationFormTemplate(
  deps: CreateApplicationFormTemplateDeps,
  rawInput: unknown,
): Promise<CreateApplicationFormTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "createApplicationFormTemplate",
  });

  const execute = async () => {
    const input = parseInput(createApplicationFormTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:create:${input.ownerScope}:${input.ownerId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredCreateResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredCreateResult>(idempotencyKey);
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

        // Courtesy pre-check only — there is no unique index behind it (see
        // the migration's design note). Two racing creates both succeed and
        // the owner sees two rows; that is a nuisance, not a corruption.
        const existing = await tx.applicationFormTemplates.findByName(
          input.ownerScope,
          input.ownerId,
          input.name,
        );
        if (existing) {
          throw fail("TEMPLATE_NAME_TAKEN");
        }

        const now = deps.clock.now();
        const created = await tx.applicationFormTemplates.create({
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description ?? null,
          // Organizer-authored templates come from the attendee builder.
          purpose: "ATTEND",
          introText: input.introText ?? null,
          questions: input.questions,
          createdByHumanId: input.actorHumanId,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "application_form_template",
          entityId: created.id,
          action: "created",
          data: {
            ownerScope: created.ownerScope,
            ownerId: created.ownerId,
            questionCount: created.questions.length,
            actorHumanId: input.actorHumanId,
          },
          at: now,
        });

        return createApplicationFormTemplateResultSchema.parse({
          templateId: created.id,
          name: created.name,
        });
      });

      await deps.idempotency.commit<StoredCreateResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("create_application_form_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createApplicationFormTemplate", execute);
  }

  return execute();
}
