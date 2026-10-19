import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ApplicationTemplateQuestion } from "@th/types";
import { fail } from "@th/errors";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "../events/_shared/ensure-actor-can-edit-event";
import { normalizeQuestionOptions } from "../events/_shared/question-options";
import { ensureTemplateOwnerAccess } from "../event-templates/permissions";
import {
  applicationTemplateQuestionsSchema,
  saveFormAsApplicationTemplateInputSchema,
  saveFormAsApplicationTemplateResultSchema,
  type SaveFormAsApplicationTemplateInput,
  type SaveFormAsApplicationTemplateResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 120;

const CHOICE_TYPES = new Set(["SINGLE_CHOICE", "MULTI_CHOICE"]);

export type SaveFormAsApplicationTemplateDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
};

interface StoredSaveResult {
  payloadHash: string;
  response: SaveFormAsApplicationTemplateResult;
}

function buildPayloadHash(input: SaveFormAsApplicationTemplateInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/**
 * Snapshot an event's CURRENT application form up into an owner's library
 * (spec Phase 4, "the form builder header gains Save as template").
 *
 * The inverse of `apply-application-form-template`, and deliberately lossy in
 * the same places: only `introText` and the question definitions travel.
 * Lifecycle fields (`opensAt`/`closesAt`/`maxSubmissions`/`autoApprove`) are
 * NOT captured — they are decisions about ONE run of ONE event ("applications
 * close 3 Sept", "cap 40"), and silently re-imposing a stale window on the
 * next event would close a form before anyone could apply.
 *
 * ── Authorization (BOTH checks) ────────────────────────────────────────────
 *
 *   1. EVENT: `ensureActorCanEditEvent` — you may only copy a form out of an
 *      event you can edit. (Read access is not enough: the form's questions
 *      are the organizer's work product.)
 *   2. TEMPLATE OWNER: `ensureTemplateOwnerAccess(edit)` on the destination
 *      scope — an org EDITOR of event X may not write into org Y's library.
 *
 * The order matters only for which denial an unauthorized caller sees; both
 * run before anything is written.
 */
export async function saveFormAsApplicationTemplate(
  deps: SaveFormAsApplicationTemplateDeps,
  rawInput: unknown,
): Promise<SaveFormAsApplicationTemplateResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "saveFormAsApplicationTemplate",
  });

  const execute = async () => {
    const input = parseInput(
      saveFormAsApplicationTemplateInputSchema,
      rawInput,
    );
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = `application-form-template:save-from-event:${input.ownerScope}:${input.ownerId}:${input.clientKey}`;

    const replay = await deps.idempotency.get<StoredSaveResult>(idempotencyKey);
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
        await deps.idempotency.get<StoredSaveResult>(idempotencyKey);
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
        // ── 1. Event guard (source) ──────────────────────────────────────
        const event = await ensureActorCanEditEvent(
          tx,
          input.eventId,
          input.actorHumanId,
        );

        // ── 2. Template-owner guard (destination) ────────────────────────
        await ensureTemplateOwnerAccess(
          tx,
          input.ownerScope,
          input.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        // Saves the attendee (ATTEND) form, the one the builder edits.
        const form = await tx.eventApplications.getForm(event.id, "ATTEND");
        if (!form) {
          throw fail("FORM_NOT_FOUND");
        }

        const existing = await tx.applicationFormTemplates.findByName(
          input.ownerScope,
          input.ownerId,
          input.name,
        );
        if (existing) {
          throw fail("TEMPLATE_NAME_TAKEN");
        }

        const questionRows = await tx.eventApplications.listQuestions(form.id);
        // `listQuestions` is already ordered; sorting again makes the
        // "position IS the order" contract of the stored array explicit and
        // independent of the repo's ORDER BY.
        const ordered = [...questionRows].sort((a, b) => a.order - b.order);

        const snapshot: ApplicationTemplateQuestion[] = ordered.map((row) => {
          const isChoice = CHOICE_TYPES.has(row.type);
          const options = normalizeQuestionOptions(row.options);
          return {
            type: row.type as ApplicationTemplateQuestion["type"],
            label: row.label,
            description: row.description,
            // Non-choice rows store null, never [] — the same shape a
            // question row holds, so a round trip through apply is a fixpoint.
            options: isChoice ? options : null,
            isRequired: row.isRequired,
          };
        });

        // Re-validate the snapshot through the SAME schema a hand-authored
        // template goes through. A live form can hold a state the template
        // schema refuses (a choice question whose options were all deleted,
        // a label that outgrew 200 chars); saving it would mint a template
        // that `apply` then refuses — a trap the organizer discovers later.
        const questions = parseInput(
          applicationTemplateQuestionsSchema,
          snapshot,
        );

        const now = deps.clock.now();
        const created = await tx.applicationFormTemplates.create({
          ownerScope: input.ownerScope,
          ownerId: input.ownerId,
          name: input.name,
          description: input.description ?? null,
          // A template is for the same builder as the form it came from.
          purpose: form.purpose,
          // The intro travels; lifecycle fields deliberately do not.
          introText: form.introText,
          questions,
          createdByHumanId: input.actorHumanId,
          createdAt: now,
        });

        await tx.audit.log({
          entity: "application_form_template",
          entityId: created.id,
          action: "saved_from_event",
          data: {
            actorHumanId: input.actorHumanId,
            ownerScope: created.ownerScope,
            ownerId: created.ownerId,
            sourceEventId: event.id,
            sourceFormId: form.id,
            questionCount: questions.length,
          },
          at: now,
        });

        return saveFormAsApplicationTemplateResultSchema.parse({
          templateId: created.id,
          name: created.name,
          questionCount: questions.length,
        });
      });

      await deps.idempotency.commit<StoredSaveResult>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("save_form_as_application_template", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("saveFormAsApplicationTemplate", execute);
  }

  return execute();
}
