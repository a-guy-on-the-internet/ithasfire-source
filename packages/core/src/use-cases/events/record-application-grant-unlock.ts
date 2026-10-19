import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  loadApprovedApplicationGrantSubmission,
  persistSubjectApplicationUnlock,
} from "./_shared/application-gate-grant";
import { attachGuestApplicationSubmission } from "./_shared/attach-guest-application-submission";
import { fail } from "@th/errors";

/**
 * Turns a verified application grant into a durable unlock for a SIGNED-IN
 * buyer — but only when that buyer is the submission's subject.
 *
 * Why this exists: checkout is signed-in only, and the buyer's browser calls
 * the API's own origin, which never receives the HttpOnly `th_ea_<eventId>`
 * grant cookie set on the web host. So the web checkout syncs the grant first
 * (`/api/events/[eventId]/sync-unlock` → `events.recordSignedApplicationUnlock`
 * → here), exactly as it already does for the password cookie, and
 * `ensureEventAccessible` then finds a durable row.
 *
 * Who gets a row (the same rule `redeemApplicationApprovalToken` applies, so a
 * guest who signs in at checkout ends up exactly where they would have if they
 * had been signed in when they clicked the link):
 *  - the submission's applicant (`humanId === buyer`), or
 *  - the buyer an ownerless GUEST submission was just attached to (verified,
 *    email-matching account — `attachGuestApplicationSubmission`).
 * Anyone else holding the grant (a forwarded link) gets nothing durable: the
 * grant keeps letting them READ the event until it expires or is revoked, but
 * it cannot be laundered into a per-account unlock.
 *
 * The grant must still hold (APPLICATION gate, submission belongs to the
 * event, status APPROVED, same approval instance) —
 * `loadApprovedApplicationGrantSubmission`. The write re-checks that under the
 * submission's row lock in one transaction
 * (`persistSubjectApplicationUnlock`), so a rescind racing this call can never
 * leave a live row behind. The row carries `applicationSubmissionId`, so a
 * later rescind revokes it via `revokeBySubmission`.
 *
 * Denials are an OUTCOME, not an error: checkout's own gate
 * (`ensureEventAccessible`) is the enforcement point and refuses cleanly with
 * FORBIDDEN when no row exists. Returning instead of throwing keeps the
 * orders-router caller free of catch-and-ignore branches.
 */

export const recordApplicationGrantUnlockInputSchema = z
  .object({
    eventId: z.string().uuid(),
    /** From the HMAC-verified grant cookie — server-injected, never client input. */
    submissionId: z.string().uuid(),
    /**
     * The approval instance the grant was issued for (`reviewedAt`, epoch
     * ms), from the same verified cookie — server-injected, never client
     * input.
     */
    approvedAtMs: z.number().int().nonnegative(),
    humanId: z.string().uuid(),
  })
  .strict();

export const recordApplicationGrantUnlockOutcomeSchema = z.enum([
  "persisted",
  "grant_invalid",
  "not_subject",
]);

export const recordApplicationGrantUnlockOutputSchema = z
  .object({
    eventId: z.string().uuid(),
    persisted: z.boolean(),
    /** Whether an ownerless guest submission was bound to the buyer. */
    attached: z.boolean(),
    outcome: recordApplicationGrantUnlockOutcomeSchema,
  })
  .strict();

export type RecordApplicationGrantUnlockInput = z.infer<
  typeof recordApplicationGrantUnlockInputSchema
>;
export type RecordApplicationGrantUnlockOutput = z.infer<
  typeof recordApplicationGrantUnlockOutputSchema
>;

export type RecordApplicationGrantUnlockDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "eventApplications"
    | "eventInvites"
    | "eventUnlocks"
    | "humans"
    | "tx"
  >;
  logger?: LoggerPort;
  /** Sentry reporter for the best-effort guest-attach swallow. */
  reportError?: ReporterPort;
};

export async function recordApplicationGrantUnlock(
  deps: RecordApplicationGrantUnlockDeps,
  rawInput: unknown,
): Promise<RecordApplicationGrantUnlockOutput> {
  const input = parseInput(recordApplicationGrantUnlockInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const submission = await loadApprovedApplicationGrantSubmission(
    deps.repos,
    event,
    { submissionId: input.submissionId, approvedAtMs: input.approvedAtMs },
  );

  const result = (
    outcome: RecordApplicationGrantUnlockOutput["outcome"],
    attached = false,
  ): RecordApplicationGrantUnlockOutput => {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: input.eventId,
      action: "application_grant_unlock",
      result: outcome,
      viewerHumanId: input.humanId,
      metadata: { submissionId: input.submissionId, attached },
    });
    return recordApplicationGrantUnlockOutputSchema.parse({
      eventId: input.eventId,
      persisted: outcome === "persisted",
      attached,
      outcome,
    });
  };

  if (!submission) {
    return result("grant_invalid");
  }

  const attached = await attachGuestApplicationSubmission(deps, {
    submission,
    viewerHumanId: input.humanId,
    useCase: "recordApplicationGrantUnlock",
    logKey: "events.recordApplicationGrantUnlock.attach_failed",
  });

  const buyerIsSubject = submission.humanId === input.humanId || attached;
  if (!buyerIsSubject) {
    return result("not_subject", attached);
  }

  // `submission.reviewedAt` is non-null here: the grant check above matched
  // it against `approvedAtMs`.
  const persisted = await persistSubjectApplicationUnlock(deps.repos, {
    eventId: event.id,
    submissionId: submission.id,
    humanId: input.humanId,
    approvedAt: new Date(input.approvedAtMs),
    inviteId: submission.inviteId,
  });
  // Rescinded (or re-approved) between the read above and the locked write.
  if (!persisted) {
    return result("grant_invalid", attached);
  }

  return result("persisted", attached);
}
