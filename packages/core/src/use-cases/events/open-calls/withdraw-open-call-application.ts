import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../../lib/io";
import { anchorOfForm } from "./_shared/open-call-anchor";
import {
  openCallApplicantAuthSchema,
  resolveOpenCallApplication,
} from "./_shared/open-call-application";
import { anchorTitle } from "./get-open-call-application-status";

export const withdrawOpenCallApplicationInputSchema = z
  .object({ auth: openCallApplicantAuthSchema })
  .strict();

export const withdrawOpenCallApplicationOutputSchema = z
  .object({
    submissionId: z.uuid(),
    status: z.literal("WITHDRAWN"),
    /** True when it was already withdrawn: nothing changed, step 7 sends nothing. */
    alreadyWithdrawn: z.boolean(),
    /** For step 7 (null on a repeat). */
    notice: z
      .object({
        kind: z.literal("application_withdrawn"),
        submissionId: z.uuid(),
        formId: z.uuid(),
        anchor: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("event"), eventId: z.uuid() }).strict(),
          z.object({ kind: z.literal("series"), seriesId: z.uuid() }).strict(),
        ]),
        title: z.string(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type WithdrawOpenCallApplicationInput = z.infer<
  typeof withdrawOpenCallApplicationInputSchema
>;
export type WithdrawOpenCallApplicationOutput = z.infer<
  typeof withdrawOpenCallApplicationOutputSchema
>;

export type WithdrawOpenCallApplicationDeps = {
  repos: Pick<
    Repos,
    "tx" | "eventApplications" | "events" | "series" | "eventDates" | "seriesOccurrences"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The applicant withdraws (FR-010), by session or status token, any time
 * before a decision: PENDING only. After a pick it's "drop out" (step 6);
 * after "not this time" there is nothing to withdraw. Both answer
 * OPEN_CALL_APPLICATION_DECIDED.
 *
 * Idempotent: a withdrawn application answers success with
 * alreadyWithdrawn true. The write is guarded (PENDING -> WITHDRAWN in one
 * statement), so a decision that commits first is never overwritten.
 */
export async function withdrawOpenCallApplication(
  deps: WithdrawOpenCallApplicationDeps,
  rawInput: unknown,
): Promise<WithdrawOpenCallApplicationOutput> {
  const input = parseInput(withdrawOpenCallApplicationInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { submission, form, anchor } = await resolveOpenCallApplication(tx, input.auth, now);
    if (submission.status === "WITHDRAWN") {
      return { submissionId: submission.id, alreadyWithdrawn: true, notice: null };
    }
    if (submission.status !== "PENDING") throw fail("OPEN_CALL_APPLICATION_DECIDED");

    const flipped = await tx.eventApplications.withdrawPendingOpenCallSubmission({
      submissionId: submission.id,
      formId: form.id,
    });
    if (!flipped) {
      const fresh = await tx.eventApplications.getOpenCallSubmissionById(submission.id);
      if (fresh?.status === "WITHDRAWN") {
        return { submissionId: submission.id, alreadyWithdrawn: true, notice: null };
      }
      throw fail("OPEN_CALL_APPLICATION_DECIDED");
    }

    const ref = anchorOfForm(form);
    await tx.audit.log({
      entity: ref.kind === "event" ? "event" : "event_series",
      entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
      action: "open_call_application_withdrawn",
      data: { formId: form.id, submissionId: submission.id, via: input.auth.kind },
      at: now,
    });
    return {
      submissionId: submission.id,
      alreadyWithdrawn: false,
      notice: {
        kind: "application_withdrawn" as const,
        submissionId: submission.id,
        formId: form.id,
        anchor: ref,
        title: anchorTitle(anchor),
      },
    };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_withdrawn",
    submissionId: result.submissionId,
    alreadyWithdrawn: result.alreadyWithdrawn,
    via: input.auth.kind,
  });

  return withdrawOpenCallApplicationOutputSchema.parse({ ...result, status: "WITHDRAWN" });
}
