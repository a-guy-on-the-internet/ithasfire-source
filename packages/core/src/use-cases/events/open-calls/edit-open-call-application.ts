import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import {
  answersSchema,
  buildQuestionsSnapshot,
  hasMissingRequiredAnswers,
} from "../_shared/application-answers";
import { anchorOfForm } from "./_shared/open-call-anchor";
import {
  dateIdsSchema,
  openCallApplicantAuthSchema,
  openCallState,
  resolveDateChoices,
  resolveOpenCallApplication,
} from "./_shared/open-call-application";
import {
  openCallApplicationViewSchema,
  projectOpenCallApplication,
} from "./get-open-call-application-status";

export const editOpenCallApplicationInputSchema = z
  .object({
    auth: openCallApplicantAuthSchema,
    answers: answersSchema,
    dateIds: dateIdsSchema,
    isPrivate: z.boolean(),
  })
  .strict();

export const editOpenCallApplicationOutputSchema = z
  .object({ application: openCallApplicationViewSchema })
  .strict();

export type EditOpenCallApplicationInput = z.input<typeof editOpenCallApplicationInputSchema>;
export type EditOpenCallApplicationOutput = z.infer<typeof editOpenCallApplicationOutputSchema>;

export type EditOpenCallApplicationDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "eventApplications"
    | "events"
    | "series"
    | "eventDates"
    | "seriesOccurrences"
    | "humans"
    | "organizations"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The applicant edits their answers, date choices and privacy (FR-010), by
 * session or status token, until someone on the organizer side first opens
 * the application (openedAt). Full replace, not a patch: the form sends the
 * whole application, validated exactly as a submit is (the CURRENT questions
 * and a fresh snapshot; dates against the call's upcoming dates).
 *
 * Refused with OPEN_CALL_APPLICATION_LOCKED once opened, with
 * OPEN_CALL_APPLICATION_DECIDED once no longer PENDING, and with
 * OPEN_CALL_CLOSED once the call is closed. The write itself re-checks
 * PENDING + openedAt null under the row lock, so an organizer "open" racing
 * this edit either lands first (edit refused) or waits for it.
 */
export async function editOpenCallApplication(
  deps: EditOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<EditOpenCallApplicationOutput> {
  const input = parseInput(editOpenCallApplicationInputSchema, rawInput);

  const updated = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { submission, form, anchor } = await resolveOpenCallApplication(tx, input.auth, now);
    // DECIDED before LOCKED: a decided application is also usually opened,
    // and "it's been decided" is the truer answer.
    if (submission.status !== "PENDING") throw fail("OPEN_CALL_APPLICATION_DECIDED");
    if (submission.openedAt !== null) throw fail("OPEN_CALL_APPLICATION_LOCKED");

    // Deliberately NO opensAt / closesAt check: the deadline only stops NEW
    // applications (FR-004), so an applicant may still fix theirs after it,
    // until the organizer side opens it or the call closes.
    const { closedReason, upcoming } = await openCallState(tx, form, anchor, now);
    if (closedReason) throw fail("OPEN_CALL_CLOSED");

    const questions = await tx.eventApplications.listQuestions(form.id);
    if (hasMissingRequiredAnswers(questions, input.answers)) {
      throw fail("APPLICATION_ANSWERS_INCOMPLETE");
    }
    const dateChoices = resolveDateChoices(anchor, upcoming, input.dateIds);

    const result = await tx.eventApplications.updateOpenCallSubmission({
      submissionId: submission.id,
      formId: form.id,
      answers: input.answers,
      questionsSnapshot: buildQuestionsSnapshot(questions),
      isPrivate: input.isPrivate,
      dateChoices,
    });
    if (!result) {
      // Lost the race with an organizer open or a decision.
      const fresh = await tx.eventApplications.getOpenCallSubmissionById(submission.id);
      if (fresh && fresh.status !== "PENDING") throw fail("OPEN_CALL_APPLICATION_DECIDED");
      if (fresh?.openedAt) throw fail("OPEN_CALL_APPLICATION_LOCKED");
      throw fail("OPEN_CALL_APPLICATION_DECIDED");
    }

    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_edited",
      data: {
        formId: form.id,
        submissionId: submission.id,
        via: input.auth.kind,
        dateChoiceCount: dateChoices.length,
        isPrivate: input.isPrivate,
      },
      at: now,
    });
    return result;
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_edited",
    submissionId: updated.id,
    via: input.auth.kind,
  });

  return editOpenCallApplicationOutputSchema.parse({
    application: await projectOpenCallApplication(deps, updated),
  });
}
