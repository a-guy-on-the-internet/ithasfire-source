import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { describeError } from "../../../lib/io";

export type AttachGuestApplicationSubmissionDeps = {
  repos: Pick<Repos, "eventApplications" | "humans">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

/**
 * Best-effort guest→account linkage (spec Phase 3 item 3). Binds an ownerless
 * GUEST submission to the signed-in `viewerHumanId` and returns whether it did
 * — which is also what makes that viewer the submission's subject and so
 * qualifies them for a durable `EventUnlock`.
 *
 * Guardrails, all three required:
 *  - the submission must still be ownerless (`humanId === null`) — the repo
 *    re-checks this as a compare-and-swap inside the write, so a forwarded
 *    link can never re-point an already-claimed submission;
 *  - the viewer's account email must MATCH the address the guest applied
 *    with. Possession of a token or grant already proves a lot, but approval
 *    links get forwarded, and attaching binds someone else's answers (and the
 *    right to withdraw them) to your identity;
 *  - the email must be VERIFIED, or "match" is just a claim.
 *
 * Deliberately NOT an account merge: no orders, tickets or unlocks move —
 * exactly one nullable FK is filled in.
 *
 * Never throws: every failure mode (missing identity, unverified/mismatched
 * email, lost CAS, the viewer already having an open application on this
 * event, a repo error) degrades to `false`. Repo errors are a deliberate
 * swallow, so they are logged AND reported (ReporterPort convention), tagged
 * with the calling use case.
 */
export async function attachGuestApplicationSubmission(
  deps: AttachGuestApplicationSubmissionDeps,
  args: {
    submission: {
      id: string;
      humanId: string | null;
      contactEmail: string | null;
    };
    viewerHumanId: string | null;
    /** Sentry `useCase` tag of the calling use case. */
    useCase: string;
    /** Log line emitted on the swallow (kept stable per caller for alerting). */
    logKey: string;
  },
): Promise<boolean> {
  const { submission, viewerHumanId, useCase, logKey } = args;

  if (!viewerHumanId || submission.humanId || !submission.contactEmail) {
    return false;
  }

  try {
    const viewer = await deps.repos.humans.getByIdWithIdentity(viewerHumanId);
    if (!viewer?.identity.emailVerified) {
      return false;
    }
    // Submission emails are lowercased at rest (submit-event-application);
    // account emails are not guaranteed to be, so fold both sides.
    if (
      viewer.identity.email.trim().toLowerCase() !==
      submission.contactEmail.trim().toLowerCase()
    ) {
      return false;
    }

    const updated = await deps.repos.eventApplications.attachSubmissionToHuman({
      submissionId: submission.id,
      humanId: viewerHumanId,
    });
    return updated !== null;
  } catch (error) {
    // Deliberate swallow — keep the log AND report (ReporterPort convention)
    // so a systematically-failing attach stays visible in Sentry.
    deps.logger?.error(logKey, {
      submissionId: submission.id,
      err: error,
      error: describeError(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase },
        extra: { submissionId: submission.id },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never change the
      // caller's outcome.
    }
    return false;
  }
}
