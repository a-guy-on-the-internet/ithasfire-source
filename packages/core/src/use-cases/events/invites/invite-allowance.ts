import type { LoggerPort } from "@th/ports/logger";
import type { AllowanceResult, RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { fail } from "@th/errors";

import { describeError } from "../../../lib/io";
import { reportSwallowed } from "./_shared";

/**
 * The invite email allowance (gated-event invite links, owner ruling
 * 2026-10-05, security review F1).
 *
 * Every invite email counts against a ROLLING 24h recipient allowance, not
 * a call count: one call can mail up to 500 people. Two buckets are charged
 * together, all or nothing:
 *   - the SENDING ACTOR (`invite-allowance:actor:<humanId>`), so one person
 *     editing many organisers' events can't multiply their reach;
 *   - the EVENT OWNER (`invite-allowance:org:<orgId>`, or
 *     `invite-allowance:human:<humanId>` for a person-owned event), so a
 *     team of editors can't either.
 *
 * Both limits come from the EVENT OWNER's track record:
 *   - {@link NEW_SENDER_DAILY_RECIPIENTS} (50) by default;
 *   - {@link TRACK_RECORD_DAILY_RECIPIENTS} (1,000) once the owner has a
 *     settled payout, or {@link MIN_DISTINCT_SCANNED_HOLDERS} (10) distinct
 *     outside holders of PAID tickets admitted at the door of events that
 *     ended at least a day ago (see `TicketsRepo.countDistinctDoorScannedHolders`
 *     for what counts: an online card-paid order with gross > 0, not a comp,
 *     POS or cash sale; ticket not refunded; holder's email verified; no
 *     self-scans, no team members, no POS auto-admits, no scans long before
 *     the doors). Free holders (comps, $0 cash sales) cost nothing to mint,
 *     so they never count.
 * So an actor sending for an established org gets 1,000 that call, and the
 * same actor sending for a brand-new organiser is held to 50 (counting what
 * they already sent anywhere today).
 *
 * New accounts (owner ruling 2026-10-06, "1(b) account-age gate"): while the
 * SENDER's account is younger than {@link NEW_ACCOUNT_AGE_SECONDS} (7 days),
 * the ACTOR bucket's limit drops to {@link NEW_ACCOUNT_DAILY_RECIPIENTS}
 * (10). The owner bucket keeps its track-record limit, and whichever bucket
 * has less left decides. Account age starts when the person created their
 * account, i.e. first signed in (owner ruling 2026-10-07):
 * `HumansRepo.getAccountCreatedAt`, the stored first-sign-in stamp
 * (`auth_user.first_signed_in_at`, set once at sign-in) or the earliest of
 * their sign-in methods, sessions and passkeys if that is older. Not the AuthUser
 * row's `createdAt`: a guest checkout creates that row, and a sign-up weeks
 * later takes it over, so the checkout would count as the account's age. Not
 * the Human row's either, which can predate any account (INVITED, POS
 * walk-up, imported humans). A failed or empty age lookup counts the account
 * as new (the safe side), logged and reported. The refusal says which rule bound it
 * (`meta.tier`), so the panel can state the right one.
 *
 * Sending at all needs a verified account email; the callers check that
 * before charging (create-event-guest-invites.ts, `EMAIL_NOT_VERIFIED`).
 *
 * Recipients a send skips because they opted out are charged like sent
 * emails and never refunded (owner ruling 2026-10-07), so the opt-out answer
 * is never free; the callers work out the amount
 * (create-event-guest-invites.ts).
 *
 * The allowance is charged BEFORE anything is created or sent. Over it =
 * `INVITE_ALLOWANCE_EXCEEDED` carrying `remaining` (the smaller of the two
 * buckets): the call sends nothing, and the organiser can retry with that
 * many. Emails that end up NOT sent (the provider rejected them, or the
 * insert threw) are handed back through the returned charge's `refund`.
 *
 * Failure posture (fix round 1, orchestrator decision 2026-10-06): this is
 * an abuse control on outbound mail, so a limiter backend failure FAILS
 * CLOSED: `SERVICE_UNAVAILABLE` (retry later), logged at error and captured
 * by the transport backstop as a thrown error. A failed track-record lookup
 * falls back to the NEW-sender limit, logged and reported (still the safe
 * side). A failed refund is reported and never thrown: the sender just gets
 * a little less allowance today. No limiter wired (unit tests, callers
 * without Redis) skips the check.
 */

export const INVITE_ALLOWANCE_WINDOW_SECONDS = 24 * 60 * 60;
export const NEW_SENDER_DAILY_RECIPIENTS = 50;
export const TRACK_RECORD_DAILY_RECIPIENTS = 1_000;
/** The ACTOR bucket's limit while the sender's account is new. */
export const NEW_ACCOUNT_DAILY_RECIPIENTS = 10;
/** An account is new until it is this old (`getAccountCreatedAt`). */
export const NEW_ACCOUNT_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Distinct outside holders admitted at the door that make a track record. */
export const MIN_DISTINCT_SCANNED_HOLDERS = 10;
/** An event's scans count once it ended at least this long ago. */
export const TRACK_RECORD_EVENT_SETTLE_SECONDS = 24 * 60 * 60;
/** A scan counts only from this long before the event starts (the doors). */
export const TRACK_RECORD_DOOR_LEAD_SECONDS = 6 * 60 * 60;

/**
 * Which rule set the limit that refused a send (`meta.tier` on
 * INVITE_ALLOWANCE_EXCEEDED): the sender's new account, or the event owner's
 * new-organiser / track-record limit.
 */
export type InviteAllowanceTier = "NEW_ACCOUNT" | "NEW_SENDER" | "TRACK_RECORD";

export type InviteAllowanceDeps = {
  repos: Pick<Repos, "tickets" | "payoutItems" | "humans">;
  rateLimit?: Pick<RateLimitPort, "consumeAllowance" | "refundAllowance"> | null;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export function inviteAllowanceActorKey(actorHumanId: string): string {
  return `invite-allowance:actor:${actorHumanId}`;
}

export function inviteAllowanceOwnerKey(
  event: Pick<EventRecord, "orgId" | "humanId">,
): string | null {
  if (event.orgId) return `invite-allowance:org:${event.orgId}`;
  if (event.humanId) return `invite-allowance:human:${event.humanId}`;
  return null;
}

/**
 * True when the event's owner has a track record: a settled (transferred)
 * payout, or at least {@link MIN_DISTINCT_SCANNED_HOLDERS} distinct outside
 * holders of PAID tickets door-scanned at events that ended a day or more
 * before `now`.
 * The payout check runs first (a cheap EXISTS); the scan count only when it
 * says no, and stops counting at the threshold.
 */
export async function ownerHasInviteTrackRecord(
  repos: Pick<Repos, "tickets" | "payoutItems">,
  event: Pick<EventRecord, "orgId" | "humanId">,
  now: Date,
): Promise<boolean> {
  const scope = event.orgId
    ? {
        owner: { orgId: event.orgId } as const,
        subject: { subjectType: "ORGANIZATION" as const, subjectId: event.orgId },
      }
    : event.humanId
      ? {
          owner: { humanId: event.humanId } as const,
          subject: { subjectType: "HUMAN" as const, subjectId: event.humanId },
        }
      : null;
  if (!scope) return false;
  if (await repos.payoutItems.subjectHasTransferredPayout(scope.subject)) {
    return true;
  }
  const holders = await repos.tickets.countDistinctDoorScannedHolders({
    owner: scope.owner,
    endedBefore: new Date(
      now.getTime() - TRACK_RECORD_EVENT_SETTLE_SECONDS * 1000,
    ),
    doorLeadSeconds: TRACK_RECORD_DOOR_LEAD_SECONDS,
    cap: MIN_DISTINCT_SCANNED_HOLDERS,
  });
  return holders >= MIN_DISTINCT_SCANNED_HOLDERS;
}

/**
 * True while the actor's account (`HumansRepo.getAccountCreatedAt`) is
 * younger than {@link NEW_ACCOUNT_AGE_SECONDS}. Throws when there is no
 * account moment; the caller counts that as new.
 */
export async function actorAccountIsNew(
  repos: Pick<Repos, "humans">,
  actorHumanId: string,
  now: Date,
): Promise<boolean> {
  const createdAt = await repos.humans.getAccountCreatedAt(actorHumanId);
  if (!createdAt) {
    throw new Error("invite sender has never signed in");
  }
  return now.getTime() - createdAt.getTime() < NEW_ACCOUNT_AGE_SECONDS * 1000;
}

/**
 * What a successful charge hands back: how many recipients were charged and
 * a `refund` for the ones that ended up not sent. `refund` never throws
 * (failures are logged and reported) and ignores amounts <= 0.
 */
export type InviteAllowanceCharge = {
  charged: number;
  refund(amount: number): Promise<void>;
};

const NO_CHARGE: InviteAllowanceCharge = {
  charged: 0,
  refund: async () => {},
};

/**
 * Charge `recipients` invite emails to the actor and the event owner, or
 * throw `INVITE_ALLOWANCE_EXCEEDED` having charged nothing (or
 * `SERVICE_UNAVAILABLE` when the limiter is down). `useCase` tags the logs
 * and reports.
 */
export async function chargeInviteAllowance(
  deps: InviteAllowanceDeps,
  args: {
    event: Pick<EventRecord, "id" | "orgId" | "humanId">;
    actorHumanId: string;
    recipients: number;
    now: Date;
    useCase: string;
  },
): Promise<InviteAllowanceCharge> {
  const rateLimit = deps.rateLimit;
  if (!rateLimit || args.recipients <= 0) return NO_CHARGE;
  const { event, useCase } = args;

  let trackRecord = false;
  try {
    trackRecord = await ownerHasInviteTrackRecord(deps.repos, event, args.now);
  } catch (error) {
    // Deliberate fallback: the smaller allowance, never none.
    deps.logger?.error(`events.${useCase}.invite_track_record_failed`, {
      eventId: event.id,
      err: error,
      error: describeError(error),
    });
    reportSwallowed(deps.reportError, error, {
      tags: { useCase, channel: "invite_track_record" },
      extra: { eventId: event.id },
    });
  }
  const ownerTier: InviteAllowanceTier = trackRecord
    ? "TRACK_RECORD"
    : "NEW_SENDER";
  const ownerLimit = trackRecord
    ? TRACK_RECORD_DAILY_RECIPIENTS
    : NEW_SENDER_DAILY_RECIPIENTS;

  let newAccount = true;
  try {
    newAccount = await actorAccountIsNew(
      deps.repos,
      args.actorHumanId,
      args.now,
    );
  } catch (error) {
    // Deliberate fallback: an unknown account age counts as new (the
    // smaller allowance), never as established.
    deps.logger?.error(`events.${useCase}.invite_account_age_failed`, {
      eventId: event.id,
      actorHumanId: args.actorHumanId,
      err: error,
      error: describeError(error),
    });
    reportSwallowed(deps.reportError, error, {
      tags: { useCase, channel: "invite_account_age" },
      extra: { eventId: event.id, actorHumanId: args.actorHumanId },
    });
  }
  const actorTier: InviteAllowanceTier = newAccount ? "NEW_ACCOUNT" : ownerTier;
  const actorLimit = newAccount
    ? Math.min(NEW_ACCOUNT_DAILY_RECIPIENTS, ownerLimit)
    : ownerLimit;

  const ownerKey = inviteAllowanceOwnerKey(event);
  const buckets = [
    {
      key: inviteAllowanceActorKey(args.actorHumanId),
      limit: actorLimit,
      tier: actorTier,
    },
    ...(ownerKey ? [{ key: ownerKey, limit: ownerLimit, tier: ownerTier }] : []),
  ];
  const entries = buckets.map(({ key, limit }) => ({ key, limit }));

  let result: AllowanceResult;
  try {
    result = await rateLimit.consumeAllowance({
      entries,
      amount: args.recipients,
      windowSeconds: INVITE_ALLOWANCE_WINDOW_SECONDS,
    });
  } catch (error) {
    // Fail CLOSED: no allowance check, no mail. Thrown, so the transport
    // backstop captures it; the caller can retry once the limiter is back.
    deps.logger?.error(`events.${useCase}.invite_allowance_failed`, {
      eventId: event.id,
      err: error,
      error: describeError(error),
    });
    throw fail("SERVICE_UNAVAILABLE", {
      message: "Invite sending is briefly unavailable. Try again shortly.",
      meta: { retryable: true },
    });
  }

  if (!result.allowed) {
    const remaining = Math.min(...result.results.map((r) => r.remaining));
    // The bucket with the least left explains `remaining`. Results come back
    // in entry order; on a tie the actor's (first) bucket is named, since a
    // new account's rule is the one specific to this sender.
    const bindingIndex = Math.max(
      0,
      result.results.findIndex((r) => r.remaining === remaining),
    );
    const binding = buckets[bindingIndex] ?? buckets[0]!;
    const { limit, tier } = binding;
    const retryAfterSeconds = Math.max(
      0,
      ...result.results.map((r) => r.retryAfterSeconds),
    );
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: event.id,
      action: "invite_allowance_exceeded",
      result: "denied",
      actorHumanId: args.actorHumanId,
      metadata: { requested: args.recipients, remaining, limit, tier },
    });
    throw fail("INVITE_ALLOWANCE_EXCEEDED", {
      meta: {
        requested: args.recipients,
        remaining,
        limit,
        tier,
        windowSeconds: INVITE_ALLOWANCE_WINDOW_SECONDS,
        retryAfterSeconds,
      },
    });
  }

  return {
    charged: args.recipients,
    refund: async (amount: number) => {
      const n = Math.min(Math.floor(amount), args.recipients);
      if (!(n > 0)) return;
      try {
        await rateLimit.refundAllowance({
          entries: entries.map(({ key }) => ({ key })),
          amount: n,
          windowSeconds: INVITE_ALLOWANCE_WINDOW_SECONDS,
        });
      } catch (error) {
        // Deliberate swallow: an un-refunded charge only costs the sender
        // some allowance until it rolls out of the window.
        deps.logger?.error(`events.${useCase}.invite_allowance_refund_failed`, {
          eventId: event.id,
          err: error,
          error: describeError(error),
        });
        reportSwallowed(deps.reportError, error, {
          tags: { useCase, channel: "invite_allowance_refund" },
          extra: { eventId: event.id, amount: n },
        });
      }
    },
  };
}
