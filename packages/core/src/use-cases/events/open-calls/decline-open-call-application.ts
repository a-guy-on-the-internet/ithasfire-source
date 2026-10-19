import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { plainTextMultilineOptional } from "../../../lib/sanitize-plain-text";
import { stampFirstOpen } from "./_shared/first-open";
import { anchorOfForm } from "./_shared/open-call-anchor";
import {
  lockDecidableSubmission,
  openCallNotThisTimeNoticeSchema,
  resolveDecidableSubmission,
  runOpenCallNotice,
  type OpenCallNotThisTimeNotice,
} from "./_shared/open-call-decision";
import { anchorTitle } from "./get-open-call-application-status";

/** Same bound as the attendee review path's rejection reason. */
export const NOT_THIS_TIME_NOTE_MAX = 500;

export const declineOpenCallApplicationInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    formId: z.uuid(),
    submissionId: z.uuid(),
    /**
     * The optional personal note (FR-018). Sanitised BEFORE the length check
     * (plainText convention); an empty note after sanitising is no note.
     */
    decisionReason: plainTextMultilineOptional(NOT_THIS_TIME_NOTE_MAX).optional(),
  })
  .strict();

export const declineOpenCallApplicationOutputSchema = z
  .object({
    submissionId: z.uuid(),
    status: z.literal("REJECTED"),
    /** True when it was already "not this time": nothing changed. */
    alreadyDeclined: z.boolean(),
    /** What step 7 sends; null on a repeat. */
    notice: openCallNotThisTimeNoticeSchema.nullable(),
  })
  .strict();

export type DeclineOpenCallApplicationInput = z.input<typeof declineOpenCallApplicationInputSchema>;
export type DeclineOpenCallApplicationOutput = z.infer<
  typeof declineOpenCallApplicationOutputSchema
>;

export type DeclineOpenCallApplicationDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Tells the applicant at once, with the note if there is one (step 7,
   * FR-018; principle 3, Nobody gets silence). After the commit; a failure
   * is logged and reported, and the decision stands.
   */
  notifyOpenCallNotThisTime?: (notice: OpenCallNotThisTimeNotice) => Promise<unknown>;
};

/**
 * "Not this time" (FR-018): the application becomes REJECTED, with an
 * optional personal note in decisionReason. Code says REJECTED; every
 * screen and email says "Not this time" (Q38).
 *
 * A DELIBERATE DEVIATION from the spec's architecture list, which names
 * "review-event-application-submission (extend for REJECTED on PERFORM)":
 * this is its own use case instead. That path is event-keyed (a series call
 * has no event), requires an APPLICATION-gated event, and deliberately
 * refuses PERFORM rows (step 2's purpose guard); a PERFORM branch would
 * reopen exactly what that guard closes. Keeping the attendee path
 * ATTEND-only keeps it simple, and this one shares the open-call auth,
 * lock and notice helpers with pick.
 *
 * Auth: edit rights on the call's event or series, as for pick. Guarded
 * from PENDING (or WAITLISTED); a picked (APPROVED) act cannot be declined
 * (OPEN_CALL_APPLICATION_DECIDED: removing them is a lineup removal), a
 * withdrawn one answers OPEN_CALL_APPLICATION_WITHDRAWN. Idempotent: an
 * application already REJECTED (by a decline or by the close sweep) is
 * success with alreadyDeclined true, and its note is NOT overwritten.
 * Stamps openedAt if nobody had opened it (a decision is a judgement).
 *
 * Concurrency: the submission row lock FOR UPDATE, then a guarded UPDATE;
 * same order and arbiter as pick, so pick vs decline on one application
 * serialise and the loser reads the winner's status.
 */
export async function declineOpenCallApplication(
  deps: DeclineOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<DeclineOpenCallApplicationOutput> {
  const input = parseInput(declineOpenCallApplicationInputSchema, rawInput);
  const note =
    input.decisionReason && input.decisionReason.length > 0 ? input.decisionReason : null;

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { form, anchor } = await resolveDecidableSubmission(tx, input, deps.logger);
    const submission = await lockDecidableSubmission(tx, form, input.submissionId);
    switch (submission.status) {
      case "REJECTED":
        return { submissionId: submission.id, alreadyDeclined: true, notice: null };
      case "PENDING":
      case "WAITLISTED":
        break;
      case "WITHDRAWN":
        throw fail("OPEN_CALL_APPLICATION_WITHDRAWN");
      default:
        throw fail("OPEN_CALL_APPLICATION_DECIDED");
    }

    const flipped = await tx.eventApplications.rejectOpenCallSubmission({
      submissionId: submission.id,
      formId: form.id,
      reviewerHumanId: input.actorHumanId,
      reviewedAt: now,
      decisionReason: note,
    });
    // Unreachable while we hold the row lock; fail closed if it ever isn't.
    if (!flipped) throw fail("OPEN_CALL_APPLICATION_DECIDED");
    await stampFirstOpen(tx, {
      form,
      submission,
      actorHumanId: input.actorHumanId,
      now,
      via: "decline",
    });

    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_declined",
      data: {
        actorHumanId: input.actorHumanId,
        formId: form.id,
        submissionId: submission.id,
        withNote: note !== null,
      },
      at: now,
    });
    const notice: OpenCallNotThisTimeNotice = {
      kind: "open_call_not_this_time",
      submissionId: submission.id,
      formId: form.id,
      anchor: ref,
      title: anchorTitle(anchor),
      decisionReason: note,
    };
    return { submissionId: submission.id, alreadyDeclined: false, notice };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_declined",
    formId: input.formId,
    submissionId: result.submissionId,
    alreadyDeclined: result.alreadyDeclined,
    actorHumanId: input.actorHumanId,
  });

  if (result.notice) {
    await runOpenCallNotice(
      deps,
      "declineOpenCallApplication",
      deps.notifyOpenCallNotThisTime,
      result.notice,
    );
  }

  return declineOpenCallApplicationOutputSchema.parse({ ...result, status: "REJECTED" });
}
