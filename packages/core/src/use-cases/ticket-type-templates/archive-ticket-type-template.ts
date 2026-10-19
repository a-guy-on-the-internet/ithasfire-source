import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  archiveTicketTypeTemplateInputSchema,
  archiveTicketTypeTemplateResultSchema,
  type ArchiveTicketTypeTemplateInput,
  type ArchiveTicketTypeTemplateResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type ArchiveTicketTypeTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredArchiveTicketTypeTemplateResult {
  payloadHash: string;
  response: ArchiveTicketTypeTemplateResult;
}

function buildPayloadHash(input: ArchiveTicketTypeTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function archiveTicketTypeTemplate(
  deps: ArchiveTicketTypeTemplateDeps,
  rawInput: unknown,
): Promise<ArchiveTicketTypeTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "archiveTicketTypeTemplate",
  });

  const execute = async () => {
    const input = parseInput(archiveTicketTypeTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `ticket-type-template:archive:${input.templateId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredArchiveTicketTypeTemplateResult>(
        idempotencyKey,
      );
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
        await deps.idempotency.get<StoredArchiveTicketTypeTemplateResult>(
          idempotencyKey,
        );
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
        const template = await tx.ticketTypeTemplates.getById(input.templateId);
        if (!template) {
          throw fail("TEMPLATE_NOT_FOUND");
        }

        // FR-005 (BLOCKING SECURITY): platform catalogue rows are read-only
        // to organizers. Rejected BEFORE any owner-access check — a null
        // ownerId leaves "who owns this" unanswerable on a row anyone can
        // name by id — and with the same TEMPLATE_NOT_FOUND a foreign
        // template gets, so the response confirms nothing. `isPlatform` and
        // `ownerId === null` are checked separately on purpose: a mis-shaped
        // row fails closed either way.
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
          return archiveTicketTypeTemplateResultSchema.parse({ ok: true });
        }

        const now = deps.clock.now();
        await tx.ticketTypeTemplates.archive({
          templateId: template.id,
          archivedAt: now,
        });

        await tx.audit.log({
          entity: "ticket_type_template",
          entityId: template.id,
          action: "archived",
          data: {
            ownerScope: template.ownerScope,
            ownerId: template.ownerId,
            actorHumanId: input.actorHumanId,
          },
          at: now,
        });

        return archiveTicketTypeTemplateResultSchema.parse({ ok: true });
      });

      await deps.idempotency.commit<StoredArchiveTicketTypeTemplateResult>(
        idempotencyKey,
        { payloadHash, response: result },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("archive_ticket_type_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("archiveTicketTypeTemplate", execute);
  }

  return execute();
}
