import type { TxRepos } from "@th/ports/repos";
import type {
  ApplicationSubmissionStatus,
  EventApplicationSubmissionRecord,
} from "@th/ports/repos/events";
import { fail } from "@th/errors";

import {
  dropWaitlistEntryForSubmission,
  type DropWaitlistEntryResult,
} from "./application-waitlist-link";
import { isDuplicateOpenApplication } from "./status-conflict";

/**
 * The durable half of rescinding an organizer decision, run INSIDE the
 * caller's transaction. Shared by `rescindEventApplicationDecision` and the
 * invite-revoke fallback (`invites/revoke-event-guest-invite.ts`), so the two
 * can't drift. Gate-type checks, authz and the back-in-review notice stay
 * with the callers.
 *
 *  1. Status back to PENDING, approval stamp, token, decision reason and
 *     invite stamp cleared. A collision with an application the applicant re-submitted
 *     maps to APPLICATION_ALREADY_SUBMITTED. `expectedFromStatuses` (optional)
 *     forwards the repo's status CAS, which throws `{ code: "conflict" }` when
 *     the row moved under the caller.
 *  2. Every unlock minted from the submission revoked (by submission id: the
 *     grant may be keyed to a redeemer other than the applicant). Anonymous
 *     `th_ea_` grants die with step 1: they require APPROVED with the same
 *     `reviewedAt`.
 *  3. A WAITLISTED decision's waitlist linkage unwound
 *     (dropWaitlistEntryForSubmission).
 *  4. The `event_application_decision_rescinded` audit row, plus any
 *     caller-specific `auditData`.
 */
export async function applyRescindDecision(
  tx: Pick<
    TxRepos,
    "eventApplications" | "eventUnlocks" | "eventWaitlists" | "audit"
  >,
  input: {
    eventId: string;
    /** The submission as read in this transaction (pre-rescind). */
    submission: EventApplicationSubmissionRecord;
    actorHumanId: string;
    at: Date;
    expectedFromStatuses?: ApplicationSubmissionStatus[];
    /**
     * Forwarded as the write's invite-stamp guard (see
     * `UpdateEventApplicationSubmissionStatusInput.expectedInviteId`): the
     * rescind only lands while the row still carries this invite.
     */
    expectedInviteId?: string;
    auditData?: Record<string, unknown>;
  },
): Promise<{
  submission: EventApplicationSubmissionRecord;
  unlockRevoked: boolean;
  waitlistResult: DropWaitlistEntryResult;
}> {
  const existing = input.submission;

  let updatedSubmission: EventApplicationSubmissionRecord;
  try {
    updatedSubmission = await tx.eventApplications.updateSubmissionStatus({
      submissionId: existing.id,
      status: "PENDING",
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      // A rescinded rejection must not carry its stale reason back into
      // PENDING (it would surface in list payloads).
      decisionReason: null,
      // Back in review, the submission is no longer invite-approved: a later
      // hand approval must not read "Via invite", stay cap-exempt, or be
      // rescinded again by a second revoke of the same invite.
      inviteId: null,
      ...(input.expectedFromStatuses
        ? { expectedFromStatuses: input.expectedFromStatuses }
        : {}),
      ...(input.expectedInviteId !== undefined
        ? { expectedInviteId: input.expectedInviteId }
        : {}),
    });
  } catch (error) {
    if (isDuplicateOpenApplication(error)) {
      throw fail("APPLICATION_ALREADY_SUBMITTED", { cause: error });
    }
    throw error;
  }

  // A subject's unlock being written concurrently cannot outlive this: that
  // write holds the submission's row lock (`lockApprovedSubmission`), so
  // either it misses because the update above committed first, or the update
  // waited for it and this revoke catches the row it wrote. Nulling
  // `reviewedAt` means re-approval does NOT revive old grants either.
  const revokedCount = await tx.eventUnlocks.revokeBySubmission(existing.id);
  const unlockRevoked = revokedCount > 0;

  // An entry the WAITLISTED decision CREATED is DROPPED (never deleted); one
  // the person joined independently only loses its submissionId linkback.
  const waitlistResult: DropWaitlistEntryResult =
    existing.status === "WAITLISTED"
      ? await dropWaitlistEntryForSubmission(tx, {
          eventId: input.eventId,
          submission: existing,
          at: input.at,
        })
      : "none";

  await tx.audit.log({
    entity: "event",
    entityId: input.eventId,
    action: "event_application_decision_rescinded",
    data: {
      actorHumanId: input.actorHumanId,
      submissionId: existing.id,
      fromStatus: existing.status,
      previousReviewerHumanId: existing.reviewerHumanId,
      unlockRevoked,
      waitlistEntryDropped: waitlistResult === "dropped",
      waitlistLinkRemoved: waitlistResult === "unlinked",
      ...input.auditData,
    },
    at: input.at,
  });

  return { submission: updatedSubmission, unlockRevoked, waitlistResult };
}
