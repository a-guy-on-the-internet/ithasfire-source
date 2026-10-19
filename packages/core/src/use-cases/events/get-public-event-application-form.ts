import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { ensureEventOpenToPublic } from "./_shared/event-open-to-public";

/**
 * PUBLIC read of an event's application form DEFINITION (spec Phase 3 item 1,
 * decision D5 — "anonymous applies ride the booking-embed pattern").
 *
 * A guest has to be able to SEE the form before they can fill it in, and the
 * questions an organizer asks are not sensitive. What IS organizer-only stays
 * behind `events.getApplicationForm`:
 *
 *   - `defaults` (which built-in fields the builder toggles on),
 *   - `maxSubmissions` (a capacity signal — "only 3 slots left" invites
 *     gaming, and the cap is enforced server-side anyway),
 *   - `autoApprove` (knowing approval is automatic changes how people apply),
 *   - `updatedByHumanId` / `updatedAt` / form + question ids' provenance,
 *   - anything submission-shaped (counts, other applicants).
 *
 * Question ids ARE returned: the submit payload is keyed by them, so they are
 * a required part of the public contract, not a leak.
 *
 * Eligibility is deliberately narrow — PUBLISHED and `gateType: APPLICATION`.
 * Every ineligible case (missing event, draft/cancelled/completed/archived,
 * a different gate type, no form configured yet) collapses to the SAME
 * `EVENT_NOT_FOUND`, so this endpoint is not an oracle for "does this event id
 * exist / what gate is it behind".
 *
 * Visibility is deliberately NOT checked: a PRIVATE or UNLISTED event behind
 * an application gate is exactly the case this exists for (the organizer hands
 * out the link and strangers apply). Nothing here is narrower than the
 * already-public `events.getGatedPreview`, which returns title + hero image
 * for any event id.
 */

export const getPublicEventApplicationFormInputSchema = z
  .object({
    eventId: z.string().uuid(),
  })
  .strict();

/** Same four shipped types the builder writes and the gate renders. */
const publicQuestionTypeSchema = z.enum([
  "SHORT_TEXT",
  "LONG_TEXT",
  "MULTI_CHOICE",
  "SINGLE_CHOICE",
]);

export const getPublicEventApplicationFormOutputSchema = z.object({
  eventId: z.string().uuid(),
  /** Organizer's blurb above the questions. */
  introText: z.string().nullable(),
  /** Application window start. Null = open now. */
  opensAt: z.date().nullable(),
  /** Application window end. Null = never closes. */
  closesAt: z.date().nullable(),
  questions: z.array(
    z.object({
      id: z.string().uuid(),
      type: publicQuestionTypeSchema,
      label: z.string(),
      description: z.string().nullable(),
      options: z.any().nullable(),
      isRequired: z.boolean(),
      order: z.number().int(),
    }),
  ),
});

export type GetPublicEventApplicationFormInput = z.infer<
  typeof getPublicEventApplicationFormInputSchema
>;
export type GetPublicEventApplicationFormOutput = z.infer<
  typeof getPublicEventApplicationFormOutputSchema
>;

export type GetPublicEventApplicationFormDeps = {
  repos: Pick<Repos, "events" | "eventApplications">;
  logger?: LoggerPort;
};

export async function getPublicEventApplicationForm(
  deps: GetPublicEventApplicationFormDeps,
  rawInput: unknown,
): Promise<GetPublicEventApplicationFormOutput> {
  const input = parseInput(getPublicEventApplicationFormInputSchema, rawInput);

  // A banned owner's event answers like every other ineligible shape
  // (ban-that-sticks) — the same gate as the submit path.
  const event = await ensureEventOpenToPublic(deps.repos, input.eventId);
  // One collapsed failure for every ineligible shape — see the header note.
  if (
    event.status !== "PUBLISHED" ||
    event.gateType !== "APPLICATION"
  ) {
    throw fail("EVENT_NOT_FOUND");
  }

  // The attendee gate's form; never the event's open call (PERFORM).
  const form = await deps.repos.eventApplications.getForm(event.id, "ATTEND");
  if (!form) {
    throw fail("EVENT_NOT_FOUND");
  }

  const questions = await deps.repos.eventApplications.listQuestions(form.id);

  // Field-by-field projection, never a spread of the form record: this is the
  // whole point of the endpoint, and a spread would silently re-leak every
  // organizer-only column added to the model later.
  return getPublicEventApplicationFormOutputSchema.parse({
    eventId: event.id,
    introText: form.introText,
    opensAt: form.opensAt,
    closesAt: form.closesAt,
    questions: questions.map((question) => ({
      id: question.id,
      type: question.type,
      label: question.label,
      description: question.description,
      options: question.options,
      isRequired: question.isRequired,
      order: question.order,
    })),
  });
}
