import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventApplicationSubmissionRecord,
  EventInviteRecord,
  EventRecord,
} from "@th/ports/repos/events";
import type { EventUnlockRecord } from "@th/ports/repos/event-unlocks";
import { fail } from "@th/errors";

import { eventEndedAt, isEventPast } from "../../../lib/event-ended";
import { parseInput } from "../../../lib/io";
import {
  hashInviteToken,
  verifyInviteToken,
} from "../../../lib/security/invite-token";
import {
  applyApprovalDecision,
  DEFAULT_TOKEN_TTL_MINUTES,
} from "../_shared/approve-submission";
import { lockInviteApprovalOrRevoked } from "../_shared/application-gate-grant";
import { dropWaitlistEntryForSubmission } from "../_shared/application-waitlist-link";
import {
  isDuplicateOpenApplication,
  isStatusConflict,
  isTransactionDeadlockOrSerialization,
} from "../_shared/status-conflict";
import { isInviteGate } from "./_shared";

/**
 * Redeem an invite link (gated-event invite links FR-004, FR-005, FR-008,
 * FR-010, R3, R4, R15). Replaces the old single-use magic-link redeemer.
 * Public: no authz; the token is the credential.
 *
 * Dead links are an OUTCOME, never a throw: `{ ok: false, reason }` and the
 * web shows the gate with "This invite link doesn't work anymore" (FR-010).
 *
 * Live link, by viewer and gate:
 *  - Signed in, already holding a LIVE EventUnlock for the event: nothing is
 *    written. The upsert would overwrite that row's source, submission and
 *    invite, so revoking this invite later would strip access the viewer
 *    also holds from elsewhere (an approval, the password).
 *  - Signed in, PASSWORD: EventUnlock (source MAGIC_LINK, inviteId).
 *  - Signed in, APPLICATION: approval (R4). Their open ATTEND submission is
 *    approved (PENDING / WAITLISTED) or, when already APPROVED, gets its
 *    unlock back; with no open one (including after a rejection, R15) a new
 *    APPROVED submission with no answers is created. Both go through
 *    `applyApprovalDecision`, so the unlock carries applicationSubmissionId
 *    and rescind works. No approval email (FR-005).
 *  - Signed out, PERSONAL, APPLICATION: an APPROVED guest submission at the
 *    invitee's email (reusing their open one), grant APPLICATION_GRANT so the
 *    web sets the existing `th_ea_` cookie. If that email is already APPROVED
 *    by the organizer (not by this invite), grant INVITE_GRANT instead, so
 *    revoking the invite still removes whoever holds the link.
 *  - Signed out otherwise: grant INVITE_GRANT (`th_ei_` cookie), no row (R4).
 *
 * Every write runs in one transaction that FIRST counts the redemption
 * (`recordRedemption`), which takes the invite's row lock. A revoke that
 * committed first shows in the returned row and the redemption rolls back
 * as REVOKED; a revoke that starts later waits for this commit, then its
 * revokeByInvite / rescind removes what was written. Re-redeeming writes
 * nothing and does not count.
 */

export const redeemEventInviteInputSchema = z
  .object({
    token: z.string().min(1).max(256),
    viewerHumanId: z.string().uuid().nullable(),
    /**
     * SERVER-INJECTED from the browser's verified `th_ei_<eventId>` cookie,
     * never client input: the invite it already holds a grant for. Lets a
     * signed-out re-redeem skip the count.
     */
    currentInviteGrantId: z.string().uuid().nullable().optional(),
    /**
     * The event the caller's URL names (`/api/events/<eventId>/invite`). A
     * token for another event is INVALID before anything is counted or
     * written.
     */
    expectedEventId: z.string().uuid().optional(),
  })
  .strict();

export const redeemEventInviteDeadReasonSchema = z.enum([
  /** Malformed, forged, or unknown token. */
  "INVALID",
  "REVOKED",
  "EVENT_ENDED",
  "EVENT_CANCELLED",
  /** Draft or archived event. */
  "EVENT_UNAVAILABLE",
  /** The event's gate was removed. */
  "NOT_GATED",
]);

export const redeemEventInviteGrantSchema = z.enum([
  "UNLOCK",
  "APPLICATION_GRANT",
  "INVITE_GRANT",
]);

export const redeemEventInviteOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      reason: redeemEventInviteDeadReasonSchema,
      /** Set when the token resolved to an event, so the web can land there. */
      eventId: z.string().uuid().nullable(),
      slug: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      eventId: z.string().uuid(),
      slug: z.string().nullable(),
      grant: redeemEventInviteGrantSchema,
      inviteId: z.string().uuid(),
      inviteKind: z.enum(["SHARED", "PERSONAL"]),
      /** APPLICATION events: the approved submission. */
      submissionId: z.string().uuid().nullable(),
      /**
       * APPLICATION_GRANT only: the approval instance (`reviewedAt` ms) the
       * `th_ea_` cookie must carry.
       */
      approvedAtMs: z.number().int().nonnegative().nullable(),
      /** Event end: the grant cookie's expiry (FR-008). */
      expiresAt: z.date(),
      /** False for a re-redeem that wrote nothing. */
      created: z.boolean(),
    })
    .strict(),
]);

export type RedeemEventInviteInput = z.infer<typeof redeemEventInviteInputSchema>;
export type RedeemEventInviteOutput = z.infer<
  typeof redeemEventInviteOutputSchema
>;
export type RedeemEventInviteDeadReason = z.infer<
  typeof redeemEventInviteDeadReasonSchema
>;

export type RedeemEventInviteDeps = {
  repos: Repos;
  clock: ClockPort;
  /** HMAC key for invite tokens. Server secret; never logged. */
  inviteTokenSecret: string;
  logger?: LoggerPort;
};

/** Thrown inside the transaction to roll it back when the invite died. */
class InviteRevokedDuringRedeem extends Error {
  constructor() {
    super("invite_revoked_during_redeem");
  }
}

/**
 * Thrown inside the transaction, after the invite's row lock, when the
 * viewer turns out to hold a live unlock already (a concurrent redeem won).
 * Rolls back the count; the caller returns the carried no-op grant.
 */
class AlreadyUnlocked extends Error {
  constructor(readonly granted: Granted) {
    super("invite_redeem_already_unlocked");
  }
}

/** Thrown inside the transaction when an approval read went stale. */
class ApprovalRaced extends Error {
  constructor() {
    super("invite_redeem_approval_raced");
  }
}

type Granted = {
  grant: z.infer<typeof redeemEventInviteGrantSchema>;
  submission: Pick<EventApplicationSubmissionRecord, "id" | "reviewedAt"> | null;
  created: boolean;
};

/**
 * The ONE "is this link live for a new arrival?" check, shared by redeem and
 * the read-only `peekEventInvite`: strict parse + HMAC (`verifyInviteToken`),
 * the hash lookup with ids that must agree, then the dead reasons in a fixed
 * order. A revoked row is REVOKED for both kinds: resetting or turning off a
 * SHARED link stops NEW entries (R5) even though its cookies still hold.
 * Reads only. `event` is set on a dead outcome once the token resolved to one.
 *
 * `expectedEventId` (optional): the event the caller's URL names. A token
 * for any other event is INVALID, with no event attached, so a mismatched
 * link reveals nothing about its real event and nothing is written for it.
 */
export async function resolveLiveInvite(
  deps: { repos: Pick<Repos, "eventInvites" | "events">; clock: ClockPort },
  token: string,
  inviteTokenSecret: string,
  expectedEventId?: string,
): Promise<
  | { ok: true; invite: EventInviteRecord; event: EventRecord; now: Date }
  | { ok: false; reason: RedeemEventInviteDeadReason; event: EventRecord | null }
> {
  const dead = (reason: RedeemEventInviteDeadReason, event: EventRecord | null = null) =>
    ({ ok: false, reason, event }) as const;

  const verified = verifyInviteToken(token, inviteTokenSecret);
  if (!verified) return dead("INVALID");
  const invite = await deps.repos.eventInvites.getByTokenHash(
    hashInviteToken(token),
  );
  if (!invite || invite.id !== verified.inviteId) return dead("INVALID");
  if (expectedEventId !== undefined && invite.eventId !== expectedEventId) {
    return dead("INVALID");
  }

  const event = await deps.repos.events.getById(invite.eventId);
  if (!event) return dead("INVALID");
  if (invite.revokedAt) return dead("REVOKED", event);
  if (event.status === "CANCELLED") return dead("EVENT_CANCELLED", event);
  if (event.status === "DRAFT" || event.status === "ARCHIVED") {
    return dead("EVENT_UNAVAILABLE", event);
  }
  const now = deps.clock.now();
  if (isEventPast(event, now)) return dead("EVENT_ENDED", event);
  if (!isInviteGate(event.gateType)) return dead("NOT_GATED", event);
  return { ok: true, invite, event, now };
}

export async function redeemEventInvite(
  deps: RedeemEventInviteDeps,
  rawInput: unknown,
): Promise<RedeemEventInviteOutput> {
  const input = parseInput(redeemEventInviteInputSchema, rawInput);
  if (!deps.inviteTokenSecret) {
    throw fail("NOT_CONFIGURED", { message: "invite_token_secret_missing" });
  }

  const dead = (
    reason: RedeemEventInviteDeadReason,
    event: Pick<EventRecord, "id" | "slug"> | null = null,
  ): RedeemEventInviteOutput => {
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: event?.id ?? null,
      action: "invite_redeem",
      result: reason,
      viewerHumanId: input.viewerHumanId,
    });
    return redeemEventInviteOutputSchema.parse({
      ok: false,
      reason,
      eventId: event?.id ?? null,
      slug: event?.slug ?? null,
    });
  };

  const resolved = await resolveLiveInvite(
    deps,
    input.token,
    deps.inviteTokenSecret,
    input.expectedEventId,
  );
  if (!resolved.ok) return dead(resolved.reason, resolved.event);
  const { invite, event, now } = resolved;

  let granted: Granted;
  try {
    granted = await grantFor(deps, input, invite, event, now);
  } catch (error) {
    if (error instanceof InviteRevokedDuringRedeem) {
      return dead("REVOKED", event);
    }
    if (error instanceof AlreadyUnlocked) {
      granted = error.granted;
    } else {
      throw error;
    }
  }

  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId: event.id,
    action: "invite_redeem",
    result: granted.created ? "granted" : "already_granted",
    viewerHumanId: input.viewerHumanId,
    metadata: {
      inviteId: invite.id,
      kind: invite.kind,
      grant: granted.grant,
      submissionId: granted.submission?.id ?? null,
    },
  });

  return redeemEventInviteOutputSchema.parse({
    ok: true,
    eventId: event.id,
    slug: event.slug ?? null,
    grant: granted.grant,
    inviteId: invite.id,
    inviteKind: invite.kind,
    submissionId: granted.submission?.id ?? null,
    approvedAtMs:
      granted.grant === "APPLICATION_GRANT"
        ? (granted.submission?.reviewedAt?.getTime() ?? null)
        : null,
    expiresAt: eventEndedAt(event),
    created: granted.created,
  });
}

function isLiveUnlock(unlock: EventUnlockRecord | null, now: Date): boolean {
  return (
    unlock !== null &&
    unlock.revokedAt === null &&
    (unlock.expiresAt === null || unlock.expiresAt.getTime() > now.getTime())
  );
}

async function grantFor(
  deps: RedeemEventInviteDeps,
  input: RedeemEventInviteInput,
  invite: EventInviteRecord,
  event: EventRecord,
  now: Date,
): Promise<Granted> {
  const viewer = input.viewerHumanId;

  if (viewer) {
    return grantInviteToSignedInViewer(deps, {
      invite,
      event,
      viewer,
      now,
      mode: "REDEEM",
    });
  }

  if (invite.kind === "PERSONAL" && event.gateType === "APPLICATION") {
    return withOneRetry(() =>
      deps.repos.tx((tx) =>
        approveForGuest(tx, {
          invite,
          event,
          now,
          currentInviteGrantId: input.currentInviteGrantId ?? null,
        }),
      ),
    );
  }

  // Signed-out SHARED (either gate) or PERSONAL on a PASSWORD event: the
  // `th_ei_` cookie is the whole grant. No row (R4).
  if (input.currentInviteGrantId === invite.id) {
    return { grant: "INVITE_GRANT", submission: null, created: false };
  }
  await deps.repos.tx((tx) => countRedemption(tx, invite, now));
  return { grant: "INVITE_GRANT", submission: null, created: true };
}

/**
 * How a signed-in viewer came to hold the invite:
 *  - REDEEM: they opened the link (token). Every new grant is counted.
 *  - CONVERT: a verified `th_ei_` cookie from an earlier signed-out redeem,
 *    turned into the durable grant they would have got signed in
 *    (`recordInviteGrantUnlock`, R3). That entry was counted when the cookie
 *    was minted, so a SHARED conversion does not count again, and must not:
 *    a reset SHARED row is revoked, yet its cookies still hold (R5, R14).
 *    It takes the row lock through `lockIfGrantsHold` instead, which sees a
 *    "Reset and remove everyone" that committed first (`grantsRevokedAt`)
 *    and makes a later one wait for this commit, so its `revokeByInvite`
 *    removes what this wrote.
 *    A PERSONAL conversion still goes through `recordRedemption`: it is the
 *    only way to take the invite's row lock and see a revoke that committed
 *    first, so a conversion racing a revoke can never leave a grant behind
 *    (FR-006). Its counter is not shown for PERSONAL rows.
 */
export type SignedInInviteGrantMode = "REDEEM" | "CONVERT";

export type SignedInInviteGrant = Granted;

/**
 * The signed-in grant for a live invite (FR-004, FR-005, R4, R15): an
 * EventUnlock on a PASSWORD event, an approval of the viewer's ATTEND
 * submission on an APPLICATION event. Never writes over a live unlock the
 * viewer already holds (checked before and again inside the transaction).
 * Shared by `redeemEventInvite` and `recordInviteGrantUnlock`.
 *
 * Throws when the invite was revoked under its row lock; test with
 * {@link isInviteRevokedDuringGrant}. The caller decides whether the invite
 * may grant at all; this only applies it.
 */
export async function grantInviteToSignedInViewer(
  deps: { repos: Repos },
  args: {
    invite: EventInviteRecord;
    event: EventRecord;
    viewer: string;
    now: Date;
    mode: SignedInInviteGrantMode;
  },
): Promise<SignedInInviteGrant> {
  const { invite, event, viewer, now, mode } = args;
  const existing = await deps.repos.eventUnlocks.get(event.id, viewer);
  if (isLiveUnlock(existing, now)) {
    // Leave the existing grant exactly as it is (see the header).
    return existingUnlockGrant(existing);
  }

  try {
    if (event.gateType === "PASSWORD") {
      await deps.repos.tx(async (tx) => {
        await countRedemptionForViewer(tx, { invite, event, viewer, now, mode });
        await tx.eventUnlocks.upsert({
          eventId: event.id,
          humanId: viewer,
          source: "MAGIC_LINK",
          applicationSubmissionId: null,
          inviteId: invite.id,
        });
        await auditRedeem(tx, {
          invite,
          event,
          viewer,
          grant: "UNLOCK",
          now,
          mode,
        });
      });
      return { grant: "UNLOCK", submission: null, created: true };
    }

    return await withOneRetry(() =>
      deps.repos.tx((tx) =>
        approveForHuman(tx, { invite, event, viewer, now, mode }),
      ),
    );
  } catch (error) {
    if (error instanceof AlreadyUnlocked) return error.granted;
    throw error;
  }
}

/** True for the rollback {@link grantInviteToSignedInViewer} throws on a revoke. */
export function isInviteRevokedDuringGrant(error: unknown): boolean {
  return error instanceof InviteRevokedDuringRedeem;
}

/**
 * Count the redemption FIRST in the transaction: the UPDATE takes the
 * invite's row lock, and a revoke that committed before it shows here.
 */
async function countRedemption(
  tx: TxRepos,
  invite: EventInviteRecord,
  now: Date,
): Promise<void> {
  const row = await tx.eventInvites.recordRedemption(invite.id, now);
  if (!row || row.revokedAt) throw new InviteRevokedDuringRedeem();
}

/**
 * {@link countRedemption}, then re-read the viewer's unlock UNDER the
 * invite's row lock. The pre-check outside the transaction races a
 * concurrent redeem by the same viewer; this read sees what that redeem
 * committed. A live unlock aborts the write (and the count) via
 * {@link AlreadyUnlocked}: the existing grant is never upserted over.
 */
async function countRedemptionForViewer(
  tx: TxRepos,
  args: {
    invite: EventInviteRecord;
    event: EventRecord;
    viewer: string;
    now: Date;
    mode: SignedInInviteGrantMode;
  },
): Promise<void> {
  // CONVERT of a SHARED grant: already counted, and may be reset (see
  // SignedInInviteGrantMode), so lock without counting. The live-unlock
  // re-read below still runs.
  if (args.mode === "REDEEM" || args.invite.kind === "PERSONAL") {
    await countRedemption(tx, args.invite, args.now);
  } else if (!(await tx.eventInvites.lockIfGrantsHold(args.invite.id))) {
    // "Reset and remove everyone" committed first: this grant is dead.
    throw new InviteRevokedDuringRedeem();
  }
  const existing = await tx.eventUnlocks.get(args.event.id, args.viewer);
  if (isLiveUnlock(existing, args.now)) {
    throw new AlreadyUnlocked(existingUnlockGrant(existing));
  }
}

function existingUnlockGrant(existing: EventUnlockRecord | null): Granted {
  return {
    grant: "UNLOCK",
    submission: existing?.applicationSubmissionId
      ? { id: existing.applicationSubmissionId, reviewedAt: null }
      : null,
    created: false,
  };
}

function approvalTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + DEFAULT_TOKEN_TTL_MINUTES * 60 * 1000);
}

/** Signed-in viewer on an APPLICATION event, inside the transaction. */
async function approveForHuman(
  tx: TxRepos,
  args: {
    invite: EventInviteRecord;
    event: EventRecord;
    viewer: string;
    now: Date;
    mode: SignedInInviteGrantMode;
  },
): Promise<Granted> {
  const { invite, event, viewer, now, mode } = args;
  // Re-checked inside the transaction: a retry after losing to a concurrent
  // redeem by the same viewer finds the winner's unlock and writes nothing.
  const existing = await tx.eventUnlocks.get(event.id, viewer);
  if (isLiveUnlock(existing, now)) return existingUnlockGrant(existing);
  // The attendee gate's form only, never the open call (PERFORM).
  const form = await tx.eventApplications.ensureForm({
    eventId: event.id,
    purpose: "ATTEND",
  });
  const open = await tx.eventApplications.findOpenSubmission({
    formId: form.id,
    humanId: viewer,
  });
  await countRedemptionForViewer(tx, { invite, event, viewer, now, mode });

  let submission: EventApplicationSubmissionRecord;
  if (open?.status === "APPROVED") {
    // Already approved, but the unlock is gone or was never written. Lock
    // the approval first (the record-application-grant-unlock pattern),
    // then look at where it came from.
    if (
      !open.reviewedAt ||
      !(await tx.eventApplications.lockApprovedSubmission({
        submissionId: open.id,
        eventId: event.id,
        purpose: "ATTEND",
        reviewedAt: open.reviewedAt,
      }))
    ) {
      throw new ApprovalRaced();
    }
    if (await lockInviteApprovalOrRevoked(tx.eventInvites, open.inviteId)) {
      // Approved by a PERSONAL invite that has since been revoked, but the
      // revoke's rescind never reached it (R9: that approval is dead). THIS
      // invite approves them now: re-approve under it, so both rows carry
      // this invite and revoking it removes them again.
      submission = await applyApprovalDecision(tx, {
        submissionId: open.id,
        eventId: event.id,
        applicantHumanId: viewer,
        reviewerHumanId: null,
        reviewedAt: now,
        tokenExpiresAt: approvalTokenExpiry(now),
        expectedFromStatuses: ["APPROVED"],
        inviteId: invite.id,
      });
    } else {
      // The organizer's approval, or a still-live invite's: restore the
      // unlock under it. An invite approval's inviteId goes on the unlock
      // (as persistSubjectApplicationUnlock does), so revoking THAT invite
      // removes it in its first phase. The approval isn't this invite's,
      // so this invite's id goes on neither row.
      await tx.eventUnlocks.upsert({
        eventId: event.id,
        humanId: viewer,
        source: "APPLICATION",
        applicationSubmissionId: open.id,
        ...(open.inviteId ? { inviteId: open.inviteId } : {}),
      });
      submission = open;
    }
  } else if (open) {
    // PENDING / WAITLISTED: the invite approves it. The CAS on the current
    // status (and the UPDATE's row lock) loses cleanly to a concurrent
    // review or withdraw.
    submission = await applyApprovalDecision(tx, {
      submissionId: open.id,
      eventId: event.id,
      applicantHumanId: viewer,
      reviewerHumanId: null,
      reviewedAt: now,
      tokenExpiresAt: approvalTokenExpiry(now),
      expectedFromStatuses: [open.status],
      inviteId: invite.id,
    });
    await dropWaitlistEntryIfWaitlisted(tx, { event, open, now });
  } else {
    // No open submission, including after a rejection (R15).
    const created = await tx.eventApplications.createSubmission({
      formId: form.id,
      eventId: event.id,
      humanId: viewer,
      contactEmail: null,
      answers: {},
      questionsSnapshot: {},
      inviteId: invite.id,
      submittedAt: now,
    });
    submission = await applyApprovalDecision(tx, {
      submissionId: created.id,
      eventId: event.id,
      applicantHumanId: viewer,
      reviewerHumanId: null,
      reviewedAt: now,
      tokenExpiresAt: approvalTokenExpiry(now),
      inviteId: invite.id,
    });
  }

  await auditRedeem(tx, {
    invite,
    event,
    viewer,
    grant: "UNLOCK",
    now,
    submissionId: submission.id,
    mode,
  });
  return { grant: "UNLOCK", submission, created: true };
}

/** Signed-out PERSONAL holder on an APPLICATION event. */
async function approveForGuest(
  tx: TxRepos,
  args: {
    invite: EventInviteRecord;
    event: EventRecord;
    now: Date;
    /** The invite a verified `th_ei_` cookie already grants, if any. */
    currentInviteGrantId: string | null;
  },
): Promise<Granted> {
  const { invite, event, now } = args;
  const email = invite.inviteeEmail;
  if (!email) {
    // A PERSONAL row without an email violates the DB CHECK; fail loudly.
    throw new Error("personal_invite_without_email");
  }
  const form = await tx.eventApplications.ensureForm({
    eventId: event.id,
    purpose: "ATTEND",
  });
  const open = await tx.eventApplications.findOpenSubmission({
    formId: form.id,
    contactEmail: email,
  });

  if (open?.status === "APPROVED" && open.inviteId === invite.id) {
    // Approved by THIS invite already: hand back the same grant, write
    // nothing. Revoking the invite rescinds this submission, so the
    // `th_ea_` grant dies with it.
    if (!open.reviewedAt) throw new ApprovalRaced();
    return { grant: "APPLICATION_GRANT", submission: open, created: false };
  }

  if (open?.status === "APPROVED") {
    // The invitee's email already holds an approval the invite did NOT
    // give (the organizer approved their own application). Handing out a
    // `th_ea_` grant on that approval would let a forwarded link outlive
    // revoking the invite (FR-006, R9). Give the invite's own grant
    // instead: `th_ei_`, re-checked against revokedAt on every read.
    if (args.currentInviteGrantId === invite.id) {
      return { grant: "INVITE_GRANT", submission: null, created: false };
    }
    await countRedemption(tx, invite, now);
    return { grant: "INVITE_GRANT", submission: null, created: true };
  }

  await countRedemption(tx, invite, now);
  let submission: EventApplicationSubmissionRecord;
  if (open) {
    submission = await applyApprovalDecision(tx, {
      submissionId: open.id,
      eventId: event.id,
      applicantHumanId: null,
      reviewerHumanId: null,
      reviewedAt: now,
      tokenExpiresAt: approvalTokenExpiry(now),
      expectedFromStatuses: [open.status],
      inviteId: invite.id,
    });
    await dropWaitlistEntryIfWaitlisted(tx, { event, open, now });
  } else {
    const created = await tx.eventApplications.createSubmission({
      formId: form.id,
      eventId: event.id,
      humanId: null,
      contactEmail: email,
      answers: {},
      questionsSnapshot: {},
      inviteId: invite.id,
      submittedAt: now,
    });
    submission = await applyApprovalDecision(tx, {
      submissionId: created.id,
      eventId: event.id,
      applicantHumanId: null,
      reviewerHumanId: null,
      reviewedAt: now,
      tokenExpiresAt: approvalTokenExpiry(now),
      inviteId: invite.id,
    });
  }

  await auditRedeem(tx, {
    invite,
    event,
    viewer: null,
    grant: "APPLICATION_GRANT",
    now,
    submissionId: submission.id,
  });
  return { grant: "APPLICATION_GRANT", submission, created: true };
}

/**
 * Approving a WAITLISTED submission supersedes the waitlist decision: drop
 * the entry that decision created (or just unlink one the person joined on
 * their own), exactly as rescinding a WAITLISTED decision does.
 */
async function dropWaitlistEntryIfWaitlisted(
  tx: TxRepos,
  args: {
    event: EventRecord;
    open: EventApplicationSubmissionRecord;
    now: Date;
  },
): Promise<void> {
  if (args.open.status !== "WAITLISTED") return;
  await dropWaitlistEntryForSubmission(tx, {
    eventId: args.event.id,
    submission: args.open,
    at: args.now,
  });
}

async function auditRedeem(
  tx: TxRepos,
  args: {
    invite: EventInviteRecord;
    event: EventRecord;
    viewer: string | null;
    grant: Granted["grant"];
    now: Date;
    submissionId?: string;
    mode?: SignedInInviteGrantMode;
  },
): Promise<void> {
  await tx.audit.log({
    entity: "event",
    entityId: args.event.id,
    action:
      args.mode === "CONVERT"
        ? "event_invite_grant_converted"
        : "event_invite_redeemed",
    data: {
      inviteId: args.invite.id,
      kind: args.invite.kind,
      viewerHumanId: args.viewer,
      grant: args.grant,
      submissionId: args.submissionId ?? null,
    },
    at: args.now,
  });
}

/**
 * One retry for the races the transaction lost: a concurrent redeem or
 * submit won the open-application unique index, a review changed the
 * status under the CAS, a rescind beat the approval lock, or Postgres
 * aborted it to break a deadlock (see the lock orders on
 * `lockInviteApprovalOrRevoked`). The failed transaction rolled back whole;
 * the retry re-reads and usually finds the winner's row (a no-op
 * re-redeem). A second loss propagates.
 */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof ApprovalRaced ||
      isDuplicateOpenApplication(error) ||
      isStatusConflict(error) ||
      isTransactionDeadlockOrSerialization(error)
    ) {
      return fn();
    }
    throw error;
  }
}
