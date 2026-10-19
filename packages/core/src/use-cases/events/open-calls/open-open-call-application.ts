import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { stampFirstOpen } from "./_shared/first-open";
import { resolveOrganizerSubmission } from "./_shared/organizer-side";
import {
  openCallQuestionsSchema,
  openCallReviewCardSchema,
  projectQuestions,
  projectReviewCard,
  TRACE_LINEUP_ROLES,
  TRACE_ORGANISER_ORG_ROLES,
} from "./_shared/review-card";
import { applicationNoteSchema, projectApplicationNote } from "./add-application-note";
import { MAX_APPLICATION_NOTES } from "./list-application-notes";

export const openOpenCallApplicationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
  })
  .strict();

export const openOpenCallApplicationOutputSchema = z
  .object({
    card: openCallReviewCardSchema,
    /** The answers: shown ONLY here, after openedAt is stamped (FR-010). */
    answers: z.record(z.string(), z.unknown()),
    questions: openCallQuestionsSchema,
    notes: z.array(applicationNoteSchema),
    /** True when THIS open stamped `openedAt` (the first open). */
    firstOpen: z.boolean(),
  })
  .strict();

export type OpenOpenCallApplicationInput = z.input<typeof openOpenCallApplicationInputSchema>;
export type OpenOpenCallApplicationOutput = z.infer<typeof openOpenCallApplicationOutputSchema>;

export type OpenOpenCallApplicationDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * Open one application card in the review queue (FR-010, FR-013).
 *
 * The FIRST open by anyone on the organizer side stamps `openedAt`; that
 * stamp is what locks the applicant's edits (step 4's edit is guarded on
 * `openedAt IS NULL` in the same row). A first vote or note stamps it too
 * (`stampFirstOpen`). The stamp is one guarded UPDATE, so it lands exactly
 * once even when two organizers open at the same moment; later opens
 * change nothing. Listing the queue never stamps, and the queue never
 * carries answers: they are returned HERE only, read after the stamp has
 * committed, so what the organizer reads is what is locked.
 *
 * Auth: organizer side; any refusal is OPEN_CALL_APPLICATION_NOT_FOUND
 * (including a submission of another call).
 */
export async function openOpenCallApplication(
  deps: OpenOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<OpenOpenCallApplicationOutput> {
  const input = parseInput(openOpenCallApplicationInputSchema, rawInput);
  const now = deps.clock.now();

  const { formId, submissionId, firstOpen } = await deps.repos.tx(async (tx) => {
    const { form, submission } = await resolveOrganizerSubmission(tx, input);
    const stamped = await stampFirstOpen(tx, {
      form,
      submission,
      actorHumanId: input.actorHumanId,
      now,
      via: "open",
    });
    return { formId: form.id, submissionId: submission.id, firstOpen: stamped };
  });

  // Read AFTER the commit: the card carries the stamp it just got, and the
  // answers are the locked ones (an applicant edit that committed just
  // before the stamp is included, none can land after it).
  const [page, fresh, notes] = await Promise.all([
    deps.repos.eventApplications.listOpenCallReviewCards({
      formId,
      viewerHumanId: input.actorHumanId,
      filter: {},
      cursor: null,
      limit: 1,
      onlySubmissionId: submissionId,
      now,
      lineupRoles: TRACE_LINEUP_ROLES,
      organiserOrgRoles: TRACE_ORGANISER_ORG_ROLES,
    }),
    deps.repos.eventApplications.getOpenCallSubmissionById(submissionId),
    deps.repos.eventApplications.listApplicationNotes({
      submissionId,
      limit: MAX_APPLICATION_NOTES,
    }),
  ]);
  const card = page.items[0];
  // Deleted between the commit and the read (its anchor went): same answer
  // as any other missing application.
  if (!card || !fresh || fresh.formId !== formId) {
    throw fail("OPEN_CALL_APPLICATION_NOT_FOUND");
  }

  if (firstOpen) {
    deps.logger?.info("open_call", {
      category: "open_call",
      action: "application_opened",
      formId,
      submissionId,
      actorHumanId: input.actorHumanId,
    });
  }

  return openOpenCallApplicationOutputSchema.parse({
    card: projectReviewCard(card),
    answers: fresh.answers,
    questions: projectQuestions(fresh.questionsSnapshot),
    notes: notes.map(projectApplicationNote),
    firstOpen,
  });
}
