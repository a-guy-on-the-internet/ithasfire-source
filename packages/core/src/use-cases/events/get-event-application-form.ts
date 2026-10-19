import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureActorCanEditEvent } from "./_shared/ensure-actor-can-edit-event";

/**
 * The ORGANIZER's read of an application form — the builder's payload.
 *
 * Distinct from `getPublicEventApplicationForm`, which serves applicants and
 * deliberately projects a narrower field list. This one carries organizer-only
 * configuration (`defaults`, `maxSubmissions`, `autoApprove`) and therefore
 * REQUIRES event-edit rights: it previously lived inline in the transport
 * layer behind nothing but "is someone signed in", which let any authenticated
 * user read any event's form configuration by id.
 */
export const getEventApplicationFormInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    eventId: z.string().uuid(),
  })
  .strict();

const applicationQuestionSchema = z.object({
  id: z.string().uuid(),
  formId: z.string().uuid(),
  type: z.enum(["SHORT_TEXT", "LONG_TEXT", "MULTI_CHOICE", "SINGLE_CHOICE"]),
  label: z.string(),
  description: z.string().nullable(),
  options: z.any().nullable(),
  isRequired: z.boolean(),
  order: z.number().int(),
});

export const getEventApplicationFormOutputSchema = z.object({
  form: z
    .object({
      id: z.string().uuid(),
      eventId: z.string().uuid(),
      introText: z.string().nullable(),
      defaults: z.object({
        includeName: z.boolean(),
        includeReason: z.boolean(),
        includeSocialLinks: z.boolean(),
      }),
      /** Application window start (spec Phase 2). Null = open now. */
      opensAt: z.date().nullable(),
      /** Application window end. Null = never closes. */
      closesAt: z.date().nullable(),
      /** Submission cap. Null = uncapped. */
      maxSubmissions: z.number().int().nullable(),
      /** Instant-approval ("registration with questions") mode. */
      autoApprove: z.boolean(),
      updatedAt: z.date(),
    })
    .nullable(),
  questions: z.array(applicationQuestionSchema),
});

export type GetEventApplicationFormInput = z.infer<
  typeof getEventApplicationFormInputSchema
>;
export type GetEventApplicationFormOutput = z.infer<
  typeof getEventApplicationFormOutputSchema
>;

export type GetEventApplicationFormDeps = {
  repos: Repos;
  logger?: LoggerPort;
};

export async function getEventApplicationForm(
  deps: GetEventApplicationFormDeps,
  rawInput: unknown,
): Promise<GetEventApplicationFormOutput> {
  const input = parseInput(getEventApplicationFormInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    // Throws EVENT_NOT_FOUND / INSUFFICIENT_ROLE before any form data is read.
    await ensureActorCanEditEvent(tx, input.eventId, input.actorHumanId);

    // The attendee gate's form (the builder this payload feeds).
    const form = await tx.eventApplications.getForm(input.eventId, "ATTEND");
    if (!form) {
      return { form: null, questions: [] };
    }

    const questions = await tx.eventApplications.listQuestions(form.id);

    return {
      form: {
        id: form.id,
        eventId: form.eventId,
        introText: form.introText,
        defaults: form.defaults,
        opensAt: form.opensAt,
        closesAt: form.closesAt,
        maxSubmissions: form.maxSubmissions,
        autoApprove: form.autoApprove,
        updatedAt: form.updatedAt,
      },
      questions: questions.map((q) => ({
        id: q.id,
        formId: q.formId,
        type: q.type,
        label: q.label,
        description: q.description,
        options: q.options,
        isRequired: q.isRequired,
        order: q.order,
      })),
    };
  });
}
