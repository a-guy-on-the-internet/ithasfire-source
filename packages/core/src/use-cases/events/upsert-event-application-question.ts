import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EventApplicationFormRecord,
  EventApplicationQuestionRecord,
  EventGateType,
  EventVisibility,
} from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { normalizeQuestionOptions } from "./_shared/question-options";
import { fail } from "@th/errors";
import {
  plainTextMultilineOptional,
  plainTextOptional,
  plainTextRequired,
} from "../../lib/sanitize-plain-text";

const questionTypes = [
  "SHORT_TEXT",
  "LONG_TEXT",
  "MULTI_CHOICE",
  "SINGLE_CHOICE",
] as const;
const choiceQuestionTypes = new Set(["MULTI_CHOICE", "SINGLE_CHOICE"]);

/** CANONICAL at-rest option shape ({ id, label }) — what the adapter stores
 * and what `questionsSnapshot` copies. */
const questionOptionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  label: plainTextRequired(200),
});
type QuestionOption = z.infer<typeof questionOptionSchema>;

/**
 * Builder-facing option shape: the web ApplicationFormBuilder (and the
 * transport input at routers/events.ts `upsertEventApplicationQuestionInput`)
 * write options as `{ value, label? }` with the display text in `value`.
 * Accepted here and NORMALIZED to the canonical `{ id, label }` shape below —
 * without this, every builder save of a choice question failed `parseInput`
 * with `invalid_input` (shape mismatch between transport and core).
 */
const builderOptionSchema = z.object({
  value: plainTextRequired(200),
  label: plainTextOptional(200).optional(),
});

/**
 * Accept either shape per item, then normalize the array to canonical
 * `{ id, label }` via the shared helper (also used by the submit-time
 * snapshot and the tolerant record read). Builder-shape items get
 * deterministic positional ids (`opt-1`, `opt-2`, …) — safe because answers
 * reference options by their human-readable text, not by id (SINGLE_CHOICE →
 * string, MULTI_CHOICE → string[]), so option ids only need uniqueness
 * within one question.
 */
const questionOptionsInputSchema = z
  .array(z.union([questionOptionSchema, builderOptionSchema]))
  .max(32)
  .transform((options): QuestionOption[] => normalizeQuestionOptions(options));

const questionFieldsSchema = z.object({
  type: z.enum(questionTypes),
  label: plainTextRequired(200),
  description: plainTextMultilineOptional(2000).nullable().optional(),
  options: questionOptionsInputSchema.optional(),
  isRequired: z.boolean().optional(),
  order: z.number().int().min(0).max(10_000).optional(),
});

export const upsertEventApplicationQuestionInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
    formId: z.string().uuid(),
    questionId: z.string().uuid().optional(),
  })
  .and(questionFieldsSchema);

const questionOutputSchema = z.object({
  id: z.string().uuid(),
  formId: z.string().uuid(),
  type: z.enum(questionTypes),
  label: z.string(),
  description: z.string().nullable(),
  options: z.array(questionOptionSchema).nullable(),
  isRequired: z.boolean(),
  order: z.number().int().min(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const upsertEventApplicationQuestionOutputSchema = z.object({
  eventId: z.string().uuid(),
  formId: z.string().uuid(),
  question: questionOutputSchema,
});

export type UpsertEventApplicationQuestionInput = z.infer<
  typeof upsertEventApplicationQuestionInputSchema
>;
export type UpsertEventApplicationQuestionOutput = z.infer<
  typeof upsertEventApplicationQuestionOutputSchema
>;

export type UpsertEventApplicationQuestionDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function upsertEventApplicationQuestion(
  deps: UpsertEventApplicationQuestionDeps,
  rawInput: unknown,
): Promise<UpsertEventApplicationQuestionOutput> {
  const input = parseInput(upsertEventApplicationQuestionInputSchema, rawInput);

  const execute = async () => {
    const { event, form, question } = await deps.repos.tx(async (tx) => {
      const editableEvent = await ensureActorCanEditEvent(
        tx,
        input.eventId,
        input.actorHumanId,
      );

      if (editableEvent.gateType !== "APPLICATION") {
        throw fail("EVENT_NOT_APPLICATION_GATED");
      }

      const formRecord = await tx.eventApplications.getForm(
        editableEvent.id,
        "ATTEND",
      );
      if (!formRecord) {
        throw fail("FORM_NOT_FOUND");
      }

      if (formRecord.id !== input.formId) {
        throw fail("FORM_MISMATCH");
      }

      const existingQuestions = await tx.eventApplications.listQuestions(
        formRecord.id,
      );
      const existingQuestion = input.questionId
        ? (existingQuestions.find((q) => q.id === input.questionId) ?? null)
        : null;

      if (input.questionId && !existingQuestion) {
        throw fail("QUESTION_NOT_FOUND");
      }

      const resolvedOrder = resolveOrder(
        input,
        existingQuestions,
        existingQuestion,
      );
      const resolvedDescription = resolveDescription(input, existingQuestion);
      const resolvedOptions = resolveOptions(input, existingQuestion);
      const resolvedIsRequired =
        input.isRequired ?? existingQuestion?.isRequired ?? false;

      const questionRecord = await tx.eventApplications.upsertQuestion({
        questionId: input.questionId,
        formId: formRecord.id,
        type: input.type,
        label: input.label,
        description: resolvedDescription,
        options: resolvedOptions,
        isRequired: resolvedIsRequired,
        order: resolvedOrder,
      });

      await tx.audit.log({
        entity: "event",
        entityId: editableEvent.id,
        action: "event_application_question_upserted",
        data: {
          actorHumanId: input.actorHumanId,
          questionId: questionRecord.id,
          type: questionRecord.type,
          order: questionRecord.order,
          mode: input.questionId ? "update" : "create",
        },
        at: deps.clock.now(),
      });

      return {
        event: editableEvent,
        form: formRecord,
        question: questionRecord,
      } as const;
    });

    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: event.id,
      visibility: event.visibility as EventVisibility,
      gateType: event.gateType as EventGateType,
      action: input.questionId
        ? "application_question_updated"
        : "application_question_created",
      result: "success",
      actorHumanId: input.actorHumanId,
      metadata: {
        formId: form.id,
        questionId: question.id,
      },
    });

    return upsertEventApplicationQuestionOutputSchema.parse({
      eventId: event.id,
      formId: form.id,
      question,
    });
  };

  return execute();
}

function resolveOrder(
  input: UpsertEventApplicationQuestionInput,
  existingQuestions: EventApplicationQuestionRecord[],
  existingQuestion: EventApplicationQuestionRecord | null,
): number {
  if (input.order !== undefined) {
    return input.order;
  }

  if (existingQuestion) {
    return existingQuestion.order;
  }

  const maxOrder = existingQuestions.reduce(
    (max, question) => Math.max(max, question.order),
    -1,
  );
  return maxOrder + 1;
}

function resolveDescription(
  input: UpsertEventApplicationQuestionInput,
  existingQuestion: EventApplicationQuestionRecord | null,
): string | null {
  if (Object.prototype.hasOwnProperty.call(input, "description")) {
    return input.description ?? null;
  }

  return existingQuestion?.description ?? null;
}

function resolveOptions(
  input: UpsertEventApplicationQuestionInput,
  existingQuestion: EventApplicationQuestionRecord | null,
): QuestionOption[] | null {
  const requiresOptions = choiceQuestionTypes.has(input.type);

  if (!requiresOptions) {
    if (input.options && input.options.length > 0) {
      throw fail("OPTIONS_NOT_ALLOWED");
    }

    return null;
  }

  const hasOptionsField = Object.prototype.hasOwnProperty.call(
    input,
    "options",
  );
  const nextOptions = hasOptionsField
    ? (input.options ?? null)
    : (existingQuestion?.options ?? null);

  if (!nextOptions || nextOptions.length === 0) {
    throw fail("OPTIONS_REQUIRED");
  }

  return nextOptions;
}
