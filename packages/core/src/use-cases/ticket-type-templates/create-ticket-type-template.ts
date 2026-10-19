import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  createTicketTypeTemplateInputSchema,
  createTicketTypeTemplateResultSchema,
  type CreateTicketTypeTemplateInput,
  type CreateTicketTypeTemplateResult,
} from "./schemas";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type CreateTicketTypeTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredCreateTicketTypeTemplateResult {
  payloadHash: string;
  response: CreateTicketTypeTemplateResult;
}

function buildPayloadHash(input: CreateTicketTypeTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function createTicketTypeTemplate(
  deps: CreateTicketTypeTemplateDeps,
  rawInput: unknown,
): Promise<CreateTicketTypeTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "createTicketTypeTemplate",
  });

  const execute = async () => {
    const input = parseInput(createTicketTypeTemplateInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `ticket-type-template:create:${input.ownerScope}:${input.ownerId}:${input.clientKey}`;

    const replay =
      await deps.idempotency.get<StoredCreateTicketTypeTemplateResult>(
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
        await deps.idempotency.get<StoredCreateTicketTypeTemplateResult>(
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
        await ensureTemplateOwnerAccess(
          tx,
          input.ownerScope,
          input.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const existing = await tx.ticketTypeTemplates.findByName(
          input.ownerScope,
          input.ownerId,
          input.name,
        );
        if (existing) {
          throw fail("TEMPLATE_NAME_TAKEN");
        }

        const now = deps.clock.now();
        const created = await tx.ticketTypeTemplates.create({
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          ticketTypes: input.ticketTypes,
          createdByHumanId: input.actorHumanId,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "ticket_type_template",
          entityId: created.id,
          action: "created",
          data: {
            ownerScope: created.ownerScope,
            ownerId: created.ownerId,
            entryCount: created.ticketTypes.length,
          },
          at: now,
        });

        return createTicketTypeTemplateResultSchema.parse({
          templateId: created.id,
        });
      });

      await deps.idempotency.commit<StoredCreateTicketTypeTemplateResult>(
        idempotencyKey,
        { payloadHash, response: result },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("create_ticket_type_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createTicketTypeTemplate", execute);
  }

  return execute();
}
