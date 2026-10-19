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

export const setOpenCallApplicationPrivacyInputSchema = z
  .object({
    auth: openCallApplicantAuthSchema,
    isPrivate: z.boolean(),
  })
  .strict();

export const setOpenCallApplicationPrivacyOutputSchema = z
  .object({
    submissionId: z.uuid(),
    isPrivate: z.boolean(),
    /** False when it already had that value: nothing changed, nothing audited. */
    changed: z.boolean(),
  })
  .strict();

export type SetOpenCallApplicationPrivacyInput = z.infer<
  typeof setOpenCallApplicationPrivacyInputSchema
>;
export type SetOpenCallApplicationPrivacyOutput = z.infer<
  typeof setOpenCallApplicationPrivacyOutputSchema
>;

export type SetOpenCallApplicationPrivacyDeps = {
  repos: Pick<
    Repos,
    "tx" | "eventApplications" | "events" | "series" | "eventDates" | "seriesOccurrences"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The applicant switches "Keep my application private" on or off (owner
 * ruling (a), FR-008), by session or status token (same auth and token
 * expiry as edit / withdraw).
 *
 * Unlike an edit, privacy is NEVER locked by time or a decision: allowed in
 * every status except WITHDRAWN, after the organizer side opened the
 * application, and after the call closed.
 *
 * It is allowed only on the identity's LATEST row on the call (the peer list
 * judges privacy by that row, per identity). Toggling an older row, e.g. the
 * one told "not this time" before a re-application, or a bandmate's older
 * row when another member re-applied for the org, would change nothing
 * anyone sees, and the applicant could not tell (they never see themselves
 * in the list). So it is refused with OPEN_CALL_APPLICATION_SUPERSEDED, in
 * either direction. The flag is never copied to the identity's other rows:
 * that would let one org member flip another member's application.
 *
 * Refused with OPEN_CALL_APPLICATION_DECIDED once withdrawn (the code edit
 * answers for a non-PENDING row). Idempotent: setting the value it already
 * has answers success with `changed: false`. The write is one guarded
 * statement that reads the old value from the LOCKED row, so a withdraw or
 * a newer row that commits first is never overwritten, and of two
 * concurrent toggles only one reports (and audits) a change. "Commits
 * first" means before the statement's snapshot: a re-application racing the
 * statement is treated as landing after the toggle, and the new row's own
 * isPrivate choice decides from then on.
 */
export async function setOpenCallApplicationPrivacy(
  deps: SetOpenCallApplicationPrivacyDeps,
  rawInput: unknown,
): Promise<SetOpenCallApplicationPrivacyOutput> {
  const input = parseInput(setOpenCallApplicationPrivacyInputSchema, rawInput);

  const result = await deps.repos.tx(async (tx) => {
    const now = deps.clock.now();
    const { submission, form } = await resolveOpenCallApplication(tx, input.auth, now);
    if (submission.status === "WITHDRAWN") throw fail("OPEN_CALL_APPLICATION_DECIDED");
    // Deliberately NO openedAt, call-state or deadline check (see above).

    const written = await tx.eventApplications.setOpenCallSubmissionPrivacy({
      submissionId: submission.id,
      formId: form.id,
      isPrivate: input.isPrivate,
    });
    if (!written) {
      // The guard missed: withdrawn (possibly just now), or not the
      // identity's latest row. Re-read to say which.
      const fresh = await tx.eventApplications.getOpenCallSubmissionById(submission.id);
      if (!fresh || fresh.status === "WITHDRAWN") throw fail("OPEN_CALL_APPLICATION_DECIDED");
      const latest = await tx.eventApplications.isLatestOpenCallSubmission({
        submissionId: submission.id,
        formId: form.id,
      });
      throw fail(latest ? "OPEN_CALL_APPLICATION_DECIDED" : "OPEN_CALL_APPLICATION_SUPERSEDED");
    }

    // From the LOCKED pre-image, not the snapshot read above.
    const changed = written.wasPrivate !== input.isPrivate;
    if (changed) {
      const ref = anchorOfForm(form);
      await tx.audit.log({
        entity: ref.kind === "event" ? "event" : "event_series",
        entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
        action: "open_call_application_privacy_set",
        data: {
          formId: form.id,
          submissionId: submission.id,
          via: input.auth.kind,
          isPrivate: input.isPrivate,
        },
        at: now,
      });
    }
    return { submissionId: submission.id, isPrivate: written.record.isPrivate, changed };
  });

  deps.logger?.info("open_call", {
    category: "open_call",
    action: "application_privacy_set",
    submissionId: result.submissionId,
    isPrivate: result.isPrivate,
    changed: result.changed,
    via: input.auth.kind,
  });

  return setOpenCallApplicationPrivacyOutputSchema.parse(result);
}
