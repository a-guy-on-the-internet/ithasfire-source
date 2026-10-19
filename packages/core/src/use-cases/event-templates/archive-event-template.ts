import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  archiveEventTemplateInputSchema,
  archiveEventTemplateResultSchema,
  type ArchiveEventTemplateInput,
  type ArchiveEventTemplateResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "./permissions";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ArchiveEventTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredArchiveTemplateResult {
  payloadHash: string;
  response: ArchiveEventTemplateResult;
}

function buildPayloadHash(input: ArchiveEventTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function archiveEventTemplate(
  deps: ArchiveEventTemplateDeps,
  rawInput: unknown,
): Promise<ArchiveEventTemplateResult> {
  const scopedLogger = deps.logger?.child({ useCase: "archiveEventTemplate" });

  const execute = async () => {
    const input = parseInput(archiveEventTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `event-template:archive:${input.templateId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredArchiveTemplateResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredArchiveTemplateResult>(idempotencyKey);
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

        if (template.archivedAt) {
          return archiveEventTemplateResultSchema.parse({ ok: true });
        }

        const now = deps.clock.now();
        await tx.eventTemplates.archive({
          templateId: template.id,
          archivedAt: now,
          archivedByHumanId: input.actorHumanId,
        });

        await tx.audit.log({
          entity: "event_template",
          entityId: template.id,
          action: "archived",
          data: { ownerScope: template.ownerScope, ownerId: template.ownerId },
          at: now,
        });

        return archiveEventTemplateResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredArchiveTemplateResult>(
        idempotencyKey,
        {
          payloadHash,
          response: result,
        },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("archive_event_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("archiveEventTemplate", execute);
  }

  return execute();
}
