import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type {
  EventApplicationSubmissionRecord,
  EventApplicationsRepo,
  EventInvitesRepo,
  EventRecord,
} from "@th/ports/repos/events";

import { isTransactionDeadlockOrSerialization } from "./status-conflict";

/**
 * What a verified application grant cookie carries into core. Both fields
 * are SERVER-INJECTED by the transport from the HMAC-verified `th_ea_<eventId>`
 * cookie; no client input may supply them.
 *
 * `approvedAtMs` pins the grant to ONE approval instance: it is the
 * submission's `reviewedAt` (epoch ms) at the moment the claim link was
 * redeemed. Approval stamps a fresh `reviewedAt`, rescind nulls it, so a
 * grant from a rescinded approval stays dead after the same submission is
 * approved again.
 */
export const applicationGrantSchema = z
  .object({
    submissionId: z.string().uuid(),
    approvedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export type ApplicationGrant = z.infer<typeof applicationGrantSchema>;

/**
 * The ONE rule for "does this application grant open this event right now?".
 *
 * An application grant is the signed `th_ea_<eventId>` cookie the web claim
 * route sets after a valid approval-token redemption. The transport verifies
 * its HMAC and hands the `{ submissionId, approvedAtMs }` it carries to the
 * use case; this function decides whether that grant still entitles its
 * holder:
 *
 *   - the event is APPLICATION-gated (a grant never opens a PASSWORD gate, and
 *     an event whose gate was switched away from APPLICATION stops honouring
 *     it);
 *   - the submission exists and belongs to THIS event (a grant for event A is
 *     dead weight on event B, even if someone re-signs a cookie name);
 *   - the submission is APPROVED *now*;
 *   - and it is the SAME approval the grant was issued for
 *     (`reviewedAt === approvedAtMs`).
 *
 *   - and, for an invite approval, the approving invite is not a REVOKED
 *     PERSONAL invite, nor a SHARED one whose grants were removed
 *     ({@link inviteApprovalRevoked}).
 *
 * The status/`reviewedAt` clauses make the grant revocable: rescind (→ PENDING),
 * withdraw, reject, expiry — any non-APPROVED status — cuts access on the very
 * next read, and re-approving the submission afterwards does not revive it
 * (the new approval has a new `reviewedAt`; only its own claim link mints a
 * grant that matches).
 *
 * Returns the submission when the grant holds, `null` otherwise. Lookup
 * failures propagate: an unanswerable grant must never read as an open gate.
 */
export async function loadApprovedApplicationGrantSubmission(
  repos: {
    eventApplications: Pick<EventApplicationsRepo, "getSubmissionById">;
    eventInvites: Pick<EventInvitesRepo, "getById">;
  },
  event: Pick<EventRecord, "id" | "gateType">,
  grant: ApplicationGrant | null | undefined,
): Promise<EventApplicationSubmissionRecord | null> {
  if (!grant) return null;
  if (event.gateType !== "APPLICATION") return null;

  const submission = await repos.eventApplications.getSubmissionById(
    grant.submissionId,
  );
  if (!submission) return null;
  // Only an ATTEND approval opens the attendee gate (open calls v1).
  if (submission.purpose !== "ATTEND") return null;
  if (submission.eventId !== event.id) return null;
  if (submission.status !== "APPROVED") return null;
  if (submission.reviewedAt?.getTime() !== grant.approvedAtMs) return null;
  if (await inviteApprovalRevoked(repos.eventInvites, submission)) return null;
  return submission;
}

/**
 * R9 on the READ path: true when the submission was approved by a PERSONAL
 * invite that has since been revoked.
 *
 * Revoking a PERSONAL invite rescinds its approvals in a second phase, one
 * transaction per submission, after the invite itself is revoked
 * (`invites/revoke-event-guest-invite.ts`). If that phase stops partway, the
 * approvals it didn't reach are still APPROVED. This check makes them stop
 * opening the gate anyway, so the revoke is enforced by the invite row
 * alone.
 *
 * A SHARED invite denies only once its grants were removed ("Reset and
 * remove everyone", `grantsRevokedAt`): a plain reset keeps the people it
 * let in (R5/R14). That removal rescinds in the same two phases, so the
 * same backstop applies. A missing invite row is not a revoke: the FK is
 * `onDelete: SetNull`, so a deleted invite leaves no stamp behind either.
 * Lookup failures propagate (fail closed, like the grant read itself).
 */
export async function inviteApprovalRevoked(
  eventInvites: Pick<EventInvitesRepo, "getById">,
  submission: Pick<EventApplicationSubmissionRecord, "inviteId">,
): Promise<boolean> {
  if (!submission.inviteId) return false;
  const invite = await eventInvites.getById(submission.inviteId);
  if (!invite) return false;
  return invite.kind === "PERSONAL"
    ? invite.revokedAt !== null
    : invite.grantsRevokedAt !== null;
}

/**
 * The in-transaction form of {@link inviteApprovalRevoked}, for callers about
 * to write an unlock off an invite approval. True when the approving invite
 * is a REVOKED PERSONAL invite, or a SHARED one whose grants were removed.
 * Otherwise it takes the invite's row lock until the transaction ends
 * (`lockIfLive` for PERSONAL, `lockIfGrantsHold` for SHARED), so a revoke
 * or removal can't commit between this check and the unlock write: one that
 * comes second waits, and its `revokeByInvite` then removes the new unlock.
 *
 * Missing rows never count as revoked (SetNull FK). `kind` is immutable, so
 * reading it before the lock is safe.
 *
 * Lock orders (they are NOT all the same):
 *  - `persistSubjectApplicationUnlock`: submission → approving invite.
 *  - `approveForHuman` (redeem, signed in): REDEEMED invite (its redemption
 *    count UPDATE) → submission → approving invite.
 *  - revoke phase 1: invite → unlocks; phase 2: submission → unlocks.
 * When the redeemed invite IS the approving invite, a redeem and a grant
 * sync for the same submission take invite and submission in opposite
 * orders, so Postgres can abort one with a deadlock (40P01 / P2034). Both
 * callers retry once on that (`withOneRetry`, and the retry in
 * `persistSubjectApplicationUnlock`); the retry re-runs every check.
 */
export async function lockInviteApprovalOrRevoked(
  eventInvites: Pick<
    EventInvitesRepo,
    "getById" | "lockIfLive" | "lockIfGrantsHold"
  >,
  inviteId: string | null | undefined,
): Promise<boolean> {
  if (!inviteId) return false;
  const invite = await eventInvites.getById(inviteId);
  if (!invite) return false;
  return invite.kind === "PERSONAL"
    ? !(await eventInvites.lockIfLive(inviteId))
    : !(await eventInvites.lockIfGrantsHold(inviteId));
}

/**
 * Writes the SUBJECT's durable APPLICATION unlock, but only while the
 * approval it was read under still holds — the shared write path for
 * `redeemApplicationApprovalToken` and `recordApplicationGrantUnlock`.
 *
 * Check and write share one transaction: `lockApprovedSubmission` re-checks
 * APPROVED + the same `reviewedAt` and takes the submission's row lock, then
 * the unlock is upserted under it. A rescind can therefore never slip in
 * between the APPROVED read and the upsert and leave a live unlock on a
 * PENDING submission: if the rescind commits first nothing is written
 * (`false`); if it comes second it waits for this commit and its
 * `revokeBySubmission` then revokes the row.
 */
export async function persistSubjectApplicationUnlock(
  repos: Pick<Repos, "tx">,
  input: {
    eventId: string;
    submissionId: string;
    humanId: string;
    /** The `reviewedAt` of the approval the caller read. */
    approvedAt: Date;
    /**
     * The submission's `inviteId` (an invite approval). Stamped on the
     * unlock so revoking a PERSONAL invite removes this holder in its first
     * transaction (`revokeByInvite`), not only in the per-submission rescind
     * that follows. Matches what `applyApprovalDecision` writes for a
     * signed-in redeemer.
     */
    inviteId?: string | null;
  },
): Promise<boolean> {
  const attempt = () => persistSubjectApplicationUnlockOnce(repos, input);
  try {
    return await attempt();
  } catch (error) {
    // Aborted to break a lock cycle (see lockInviteApprovalOrRevoked): the
    // transaction rolled back whole, so run it once more. A second loss
    // propagates.
    if (isTransactionDeadlockOrSerialization(error)) return attempt();
    throw error;
  }
}

async function persistSubjectApplicationUnlockOnce(
  repos: Pick<Repos, "tx">,
  input: Parameters<typeof persistSubjectApplicationUnlock>[1],
): Promise<boolean> {
  return repos.tx(async (tx) => {
    const stillApproved = await tx.eventApplications.lockApprovedSubmission({
      submissionId: input.submissionId,
      eventId: input.eventId,
      // An EventUnlock is the attendee gate's grant: only an approval on
      // the ATTEND form may mint one, never a PERFORM (open call) approval.
      purpose: "ATTEND",
      reviewedAt: input.approvedAt,
    });
    if (!stillApproved) return false;
    // The caller checked the invite before this transaction; a PERSONAL
    // revoke committing since then must not leave a fresh unlock behind
    // (its first phase would already have run). Re-checked under the lock.
    if (await lockInviteApprovalOrRevoked(tx.eventInvites, input.inviteId)) {
      return false;
    }

    await tx.eventUnlocks.upsert({
      eventId: input.eventId,
      humanId: input.humanId,
      source: "APPLICATION",
      applicationSubmissionId: input.submissionId,
      ...(input.inviteId ? { inviteId: input.inviteId } : {}),
    });
    return true;
  });
}
