import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { EventGateType, EventVisibility } from "@th/ports/repos/events";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";
import { fail } from "@th/errors";

export const deleteEventApplicationQuestionInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  formId: z.string().uuid(),
  questionId: z.string().uuid(),
});

export const deleteEventApplicationQuestionOutputSchema = z.object({
  eventId: z.string().uuid(),
  formId: z.string().uuid(),
  questionId: z.string().uuid(),
});

export type DeleteEventApplicationQuestionInput = z.infer<
  typeof deleteEventApplicationQuestionInputSchema
>;
export type DeleteEventApplicationQuestionOutput = z.infer<
  typeof deleteEventApplicationQuestionOutputSchema
>;

export type DeleteEventApplicationQuestionDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function deleteEventApplicationQuestion(
  deps: DeleteEventApplicationQuestionDeps,
  rawInput: unknown,
): Promise<DeleteEventApplicationQuestionOutput> {
  const input = parseInput(deleteEventApplicationQuestionInputSchema, rawInput);

  const { event, form } = await deps.repos.tx(async (tx) => {
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

    const questions = await tx.eventApplications.listQuestions(formRecord.id);
    const question = questions.find((q) => q.id === input.questionId) ?? null;

    if (!question) {
      throw fail("QUESTION_NOT_FOUND");
    }

    await tx.eventApplications.deleteQuestion(question.id);

    await tx.audit.log({
      entity: "event",
      entityId: editableEvent.id,
      action: "event_application_question_deleted",
      data: {
        actorHumanId: input.actorHumanId,
        formId: formRecord.id,
        questionId: question.id,
        questionType: question.type,
        questionOrder: question.order,
      },
      at: deps.clock.now(),
    });

    return { event: editableEvent, form: formRecord } as const;
  });

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    visibility: event.visibility as EventVisibility,
    gateType: event.gateType as EventGateType,
    action: "application_question_deleted",
    result: "success",
    actorHumanId: input.actorHumanId,
    metadata: {
      formId: form.id,
      questionId: input.questionId,
    },
  });

  return deleteEventApplicationQuestionOutputSchema.parse({
    eventId: event.id,
    formId: form.id,
    questionId: input.questionId,
  });
}
