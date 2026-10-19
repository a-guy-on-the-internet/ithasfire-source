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
  archiveApplicationFormTemplateInputSchema,
  archiveApplicationFormTemplateResultSchema,
  type ArchiveApplicationFormTemplateInput,
  type ArchiveApplicationFormTemplateResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ArchiveApplicationFormTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredArchiveResult {
  payloadHash: string;
  response: ArchiveApplicationFormTemplateResult;
}

function buildPayloadHash(input: ArchiveApplicationFormTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Retire an OWNED template from the picker. Soft — nothing that was ever
 * forked from it is touched (fork-on-use, spec D4), so this is purely "stop
 * offering it".
 */
export async function archiveApplicationFormTemplate(
  deps: ArchiveApplicationFormTemplateDeps,
  rawInput: unknown,
): Promise<ArchiveApplicationFormTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "archiveApplicationFormTemplate",
  });

  const execute = async () => {
    const input = parseInput(
      archiveApplicationFormTemplateInputSchema,
      rawInput,
    );
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:archive:${input.templateId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredArchiveResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredArchiveResult>(idempotencyKey);
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

        // Read-only catalogue rows are refused BEFORE the owner check and
        // with the same code a foreign row gets — see the identical guard in
        // update-application-form-template.ts.
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

        // Already archived: succeed silently. Archiving is idempotent by
        // nature and a second click should not surface an error.
        if (template.archivedAt) {
          return archiveApplicationFormTemplateResultSchema.parse({ ok: true });
        }

        const now = deps.clock.now();
        await tx.applicationFormTemplates.archive({
          templateId: template.id,
          archivedAt: now,
        });

        await tx.audit.log({
          entity: "application_form_template",
          entityId: template.id,
          action: "archived",
          data: {
            ownerScope: template.ownerScope,
            ownerId: template.ownerId,
            actorHumanId: input.actorHumanId,
          },
          at: now,
        });

        return archiveApplicationFormTemplateResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredArchiveResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("archive_application_form_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("archiveApplicationFormTemplate", execute);
  }

  return execute();
}
