import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  inviteApprovalRevoked,
  persistSubjectApplicationUnlock,
} from "./_shared/application-gate-grant";
import { attachGuestApplicationSubmission } from "./_shared/attach-guest-application-submission";
import { fail } from "@th/errors";

/**
 * Redeems the `approvalToken` minted on an APPLICATION-gated event submission
 * when the organizer approves it:
 *   - Signed-in SUBJECT of the submission (its applicant, or a guest applicant
 *     whose ownerless submission this redemption just attached to them) →
 *     persist a humanId `EventUnlock(source:"APPLICATION")`.
 *   - Anyone else — anonymous, or signed in as a DIFFERENT account (a
 *     forwarded link) → nothing is persisted; the caller (web claim route)
 *     sets the short-lived, APPLICATION-scoped `th_ea_<eventId>` grant cookie
 *     carrying `submissionId` and `approvedAt`. Every read re-checks that
 *     submission is still APPROVED for this event under that same approval
 *     (`_shared/application-gate-grant.ts`), so the grant dies the moment the
 *     decision is rescinded and stays dead if it is approved again. A durable, per-account
 *     grant must never be mintable by whoever holds a forwarded bearer link
 *     for its 7-day window.
 *
 * Redemption is NON-CONSUMING and expiry-bound: the token is validated and the
 * grant issued, but the token is deliberately NOT invalidated. Email link
 * prefetchers / scanners must be safe to hit it, and the link should work for
 * the whole TTL window (organizer-set, default 7 days).
 */

export const redeemApplicationApprovalTokenInputSchema = z
  .object({
    eventId: z.string().uuid(),
    token: z.string().min(1).max(128),
    /**
     * The human redeeming the link. The unlock is persisted only when this is
     * the submission's subject (see above); otherwise the caller relies on
     * the signed cookie.
     */
    viewerHumanId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const redeemApplicationApprovalTokenOutputSchema = z.object({
  eventId: z.string().uuid(),
  /**
   * The approved submission the token belongs to. The web claim route signs
   * it into the application grant cookie; access checks look it up and
   * require it to still be APPROVED. Not a secret — the cookie's HMAC, not
   * the id, is the authenticator.
   */
  submissionId: z.string().uuid(),
  /**
   * The approval instance (`submission.reviewedAt`) the token belongs to. The
   * claim route signs it into the grant next to `submissionId`; a grant only
   * counts while the submission still carries this exact `reviewedAt`, so a
   * rescind followed by a re-approval does not revive it.
   */
  approvedAt: z.date(),
  /** Canonical event slug so the web route can redirect to `/events/<slug>`. */
  slug: z.string(),
  unlocked: z.boolean(),
  /** Whether a humanId `EventUnlock` row was persisted. */
  persisted: z.boolean(),
  /**
   * Whether this redemption bound a previously-ownerless GUEST submission to
   * the signed-in redeemer (spec Phase 3 item 3). Observability only — the
   * unlock does not depend on it.
   */
  attached: z.boolean(),
});

export type RedeemApplicationApprovalTokenInput = z.infer<
  typeof redeemApplicationApprovalTokenInputSchema
>;
export type RedeemApplicationApprovalTokenOutput = z.infer<
  typeof redeemApplicationApprovalTokenOutputSchema
>;

export type RedeemApplicationApprovalTokenDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "eventApplications"
    | "eventInvites"
    | "eventUnlocks"
    | "humans"
    | "tx"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Sentry reporter for the best-effort attach swallow (the unlock is
   * authoritative; a failed attach must never fail the redemption).
   */
  reportError?: ReporterPort;
};

export async function redeemApplicationApprovalToken(
  deps: RedeemApplicationApprovalTokenDeps,
  rawInput: unknown,
): Promise<RedeemApplicationApprovalTokenOutput> {
  const input = parseInput(redeemApplicationApprovalTokenInputSchema, rawInput);

  const submission =
    await deps.repos.eventApplications.getSubmissionByToken(input.token);

  // Collapse every "bad token" case (missing / unknown / event mismatch /
  // not-approved / no token / no approval stamp) into one generic failure so
  // we never leak which check failed to a token-guesser. Every approval
  // stamps `reviewedAt`; an APPROVED row without one cannot be bound to an
  // approval instance, so it fails closed.
  // A PERFORM (open-call) submission's token never redeems as an attendee
  // approval (open calls v1): it joins the same collapsed failure.
  if (
    !submission ||
    submission.purpose !== "ATTEND" ||
    submission.eventId !== input.eventId ||
    submission.status !== "APPROVED" ||
    !submission.approvalToken ||
    !submission.tokenExpiresAt ||
    !submission.reviewedAt ||
    // R9: an approval from a revoked PERSONAL invite is dead even if the
    // revoke's rescind phase never reached this row.
    (await inviteApprovalRevoked(deps.repos.eventInvites, submission))
  ) {
    // Deliberately do NOT log any slice of the token — it's a bearer secret.
    deps.logger?.warn("application_token_invalid", {
      category: "event_gate",
      eventId: input.eventId,
    });
    throw fail("APPLICATION_TOKEN_INVALID");
  }

  const now = deps.clock.now();
  if (submission.tokenExpiresAt.getTime() <= now.getTime()) {
    deps.logger?.warn("application_token_expired", {
      category: "event_gate",
      eventId: submission.eventId,
      submissionId: submission.id,
      expiresAt: submission.tokenExpiresAt.toISOString(),
    });
    throw fail("APPLICATION_TOKEN_EXPIRED");
  }

  const event = await deps.repos.events.getById(submission.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  // ── Attach a guest submission to the signed-in redeemer ─────────────────
  // Runs BEFORE the unlock decision: a successful attach is what makes a
  // guest applicant the subject of their own submission.
  //
  // Spec Phase 3 item 3: a guest applies with an email, gets approved, then
  // signs up / signs in with the SAME email and clicks their claim link. Bind
  // the submission to that account so it shows up in their own application
  // status (and can be withdrawn by them) instead of staying ownerless. The
  // guardrails (ownerless CAS, verified + matching email) live in the shared
  // helper, which the checkout grant sync uses too.
  const attached = await attachGuestApplicationSubmission(deps, {
    submission,
    viewerHumanId: input.viewerHumanId ?? null,
    useCase: "redeemApplicationApprovalToken",
    logKey: "events.redeemApplicationToken.attach_failed",
  });

  // ── Durable unlock: the SUBJECT only ────────────────────────────────────
  // The claim link is a bearer token that lives 7 days and is deliberately
  // NON-CONSUMING (prefetchers must not burn it), so it gets forwarded. A
  // durable per-account unlock for whoever is signed in when they click
  // would hand permanent access to anyone the email reaches. Persist only for
  // the submission's applicant, or for the guest applicant this redemption
  // just bound to their (verified, email-matching) account. Every other
  // clicker gets what an anonymous clicker gets: the web route's 24h signed
  // application grant, which is re-checked against the submission's status on
  // every use. NON-CONSUMING either way — the token is never invalidated here.
  const viewerIsSubject =
    !!input.viewerHumanId &&
    (submission.humanId === input.viewerHumanId || attached);
  //
  // The write re-checks the approval under the submission's row lock in one
  // transaction (`persistSubjectApplicationUnlock`): a rescind that commits
  // after the read above makes it miss, and the token is then no longer
  // valid — the same answer the redeemer would get a moment later.
  const approvedAt = submission.reviewedAt;
  let persisted = false;
  if (viewerIsSubject && input.viewerHumanId) {
    persisted = await persistSubjectApplicationUnlock(deps.repos, {
      eventId: submission.eventId,
      submissionId: submission.id,
      humanId: input.viewerHumanId,
      approvedAt,
      inviteId: submission.inviteId,
    });
    if (!persisted) {
      deps.logger?.warn("application_token_invalid", {
        category: "event_gate",
        eventId: submission.eventId,
        submissionId: submission.id,
        reason: "approval_changed_during_redeem",
      });
      throw fail("APPLICATION_TOKEN_INVALID");
    }
  }

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: submission.eventId,
    action: "application_token_redeemed",
    result: "success",
    metadata: {
      submissionId: submission.id,
      persisted,
      attached,
    },
  });

  return redeemApplicationApprovalTokenOutputSchema.parse({
    eventId: submission.eventId,
    submissionId: submission.id,
    approvedAt,
    slug: event.slug,
    unlocked: true,
    persisted,
    attached,
  });
}
