import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { resolveUnitPriceCents } from "../../lib/orders/door-pricing";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { createCompOrder } from "../comp/issue-comp-tickets";
import { ensureGuestHumanKeepingName } from "../../lib/ensure-guest-human";
import {
  sendTicketIssuedEmail,
  type SendTicketIssuedEmailDeps,
} from "../orders/send-ticket-issued-email";
import { grantVolunteerRewardInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type GrantVolunteerRewardDeps = {
  repos: Repos;
  clock: ClockPort;
  idempotency: IdempotencyPort;
  mailer: MailerPort;
  /** Public web origin — comp-ticket email links + QR codes. */
  publicAppUrl: string;
  /** Support hub URL plumbed into the ticket email. */
  supportUrl: string;
  /** Self-hosted tileserver base URL for static map images (optional). */
  tileServerUrl?: string;
  /**
   * Best-effort error reporter for the branches that CATCH and return a
   * degraded-but-successful result (CLAUDE.md's error-reporting convention).
   *
   * Two such branches exist here and both are on the money path:
   *
   *  - the `duplicate_grant` race, which swallows a thrown error and answers
   *    `ALREADY_GRANTED` — previously emitting nothing at all, so a comp
   *    double-fire storm was completely invisible;
   *  - the post-commit comp email, which is logged at `error` (captured by
   *    Sentry's pinoIntegration) and now also reported directly, so it is
   *    visible with a stack even where the log integration isn't mounted.
   *
   * Always invoked guarded — a throwing reporter must never change the
   * outcome of a durable grant.
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

export type GrantVolunteerRewardSkip =
  | "ALREADY_GRANTED"
  | "BUDGET_EXHAUSTED"
  | "INACTIVE"
  | "REWARD_NOT_FOUND";

export type GrantVolunteerRewardOutput = {
  ok: true;
  grantId: string | null;
  skipped?: GrantVolunteerRewardSkip;
};

/** Held only long enough to serialize a re-fire; the DB unique is the real backstop. */
const IDEMPOTENCY_TTL_SECONDS = 30;

/**
 * Retention for the non-error `fail()` calls below — the ones whose whole
 * purpose is to NOT hold the key.
 *
 * `fail()` does not release anything: both adapters write a `failed` marker
 * with 15 minutes of retention by default, `begin()` refuses to re-claim
 * until it expires, and `get()` never replays a non-`succeeded` key. Taking
 * the default would mean a BUDGET_EXHAUSTED skip locks that (reward, signup)
 * pair out for a quarter of an hour — so the revoke-frees-a-slot retry this
 * use case exists to allow would throw IDEMPOTENCY_LOCK_IN_PROGRESS, which
 * is the exact opposite of the intent. 1s is the smallest value every
 * adapter accepts (Redis `SET … EX 0` errors); same constant and reasoning
 * as `claimBookingRequest`'s DETERMINISTIC_FAILURE_KEEP_SECONDS.
 *
 * The genuine-error branch deliberately keeps the adapters' default: an
 * unknown failure mid-grant is exactly the case where a short hold is worth
 * having.
 */
const RETRYABLE_OUTCOME_KEEP_SECONDS = 1;

type StoredGrant = { response: GrantVolunteerRewardOutput };

type TxOutcome =
  | {
      kind: "granted";
      grantId: string;
      compOrderId: string;
      /**
       * Contact email for a SHADOW (guest) recipient — one who has no linked
       * Human yet (`signup.humanId == null`). Non-null only for shadows; the
       * post-commit send turns it into an `/auth/complete` account-claim link
       * so the comp ticket can be attached to an account they control. Null
       * for recipients who already have an account.
       */
      shadowClaimEmail: string | null;
    }
  | { kind: "already"; grantId: string }
  | {
      kind: "skip";
      skipped: Exclude<GrantVolunteerRewardSkip, "ALREADY_GRANTED">;
    };

function buildIdempotencyKey(rewardId: string, signupId: string): string {
  return `volunteer:reward:grant:${rewardId}:${signupId}`;
}

function isDuplicateGrantError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "duplicate_grant"
  );
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Issue the $0 comp ticket for a signup that reached its reward trigger. NOT
 * client-callable — fired system-side by the review / check-in triggers, so it
 * carries NO actor RBAC (the trigger already authorized the state change).
 *
 * Money-path invariants (NFR-001/002, spec risks #1/#2):
 *
 * - Idempotent on (rewardId, signupId): the IdempotencyPort claim plus the
 *   DB `@@unique([rewardId, signupId])` mean a retried or re-fired trigger can
 *   never double-comp. A live grant short-circuits to ALREADY_GRANTED.
 * - Budget cap serialized: `getRewardForUpdate` takes a `SELECT … FOR UPDATE`
 *   on the reward row, so concurrent grants block until the winner's
 *   `grantsUsed` increment commits — `grantsUsed` can never overshoot
 *   `maxGrants`. An exhausted budget is a logged SKIP, not an error.
 * - DELIBERATELY NOT GATED ON THE TICKET TYPE'S SALES WINDOW (packs FR-014).
 *   The reward fires when a volunteer completes their shift, which routinely
 *   happens after advance sales have closed — often during the event itself.
 *   Refusing the grant then would punish the volunteer for the tier's retail
 *   schedule. `assertTicketTypeOnSale` guards the five sites that TAKE MONEY;
 *   a $0 earned comp is not one of them.
 *
 * - The comp is minted through the existing ticketing path (`createCompOrder`
 *   → mints via `mintTicketsForOrder`), so scan / transfer / refund behave
 *   normally. `faceValueCents` snapshots `TicketType.priceCents` for the
 *   ledger only — no platform-funded credit.
 *
 * Skips (`BUDGET_EXHAUSTED`, `INACTIVE`, reward-gone) release the idempotency
 * lock rather than caching, so a later retry (e.g. after a revoke frees a
 * slot) can still succeed. Only a granted / already-granted outcome is cached.
 */
export async function grantVolunteerReward(
  deps: GrantVolunteerRewardDeps,
  rawInput: unknown,
): Promise<GrantVolunteerRewardOutput> {
  const input = parseInput(grantVolunteerRewardInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "grantVolunteerReward" });
  const key = buildIdempotencyKey(input.rewardId, input.signupId);

  // Cheap pre-reads before claiming the lock: a cached result or an existing
  // live grant both short-circuit without touching the comp path.
  const cached = await deps.idempotency.get<StoredGrant>(key);
  if (cached) return cached.response;

  const preExisting = await deps.repos.volunteering.getGrantByRewardAndSignup(
    input.rewardId,
    input.signupId,
  );
  if (preExisting) {
    return { ok: true, grantId: preExisting.id, skipped: "ALREADY_GRANTED" };
  }

  const claimed = await deps.idempotency.begin(key, IDEMPOTENCY_TTL_SECONDS);
  if (!claimed) {
    const replay = await deps.idempotency.get<StoredGrant>(key);
    if (replay) return replay.response;
    // Another run holds the lock but hasn't committed. If it already wrote the
    // grant row, echo ALREADY_GRANTED; otherwise surface the in-progress lock.
    const raced = await deps.repos.volunteering.getGrantByRewardAndSignup(
      input.rewardId,
      input.signupId,
    );
    if (raced) {
      return { ok: true, grantId: raced.id, skipped: "ALREADY_GRANTED" };
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let outcome: TxOutcome;
  try {
    outcome = await runGrantTransaction(deps, input, logger);
  } catch (error) {
    if (isDuplicateGrantError(error)) {
      // A concurrent grant won the insert race between our in-tx pre-check and
      // the create. The reward-row lock makes this vanishingly rare, but honor
      // it: the other tx owns the single live grant.
      const existing = await deps.repos.volunteering.getGrantByRewardAndSignup(
        input.rewardId,
        input.signupId,
      );
      // Deliberate swallow on the money path: the caller is told the grant
      // succeeded. "Vanishingly rare" is a claim about the reward-row lock, and
      // the only way to find out it stopped holding is to see this. Log AND
      // report — `logger.warn` is not captured by Sentry's pinoIntegration.
      logger?.warn("grantVolunteerReward.duplicate_grant_race", {
        rewardId: input.rewardId,
        signupId: input.signupId,
        existingGrantId: existing?.id ?? null,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "grantVolunteerReward", reason: "duplicate_grant" },
          extra: {
            rewardId: input.rewardId,
            signupId: input.signupId,
            trigger: input.trigger,
            existingGrantId: existing?.id ?? null,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never turn the
        // ALREADY_GRANTED fallback into a thrown error on a durable grant.
      }
      return {
        ok: true,
        grantId: existing?.id ?? null,
        skipped: "ALREADY_GRANTED",
      };
    }
    await deps.idempotency.fail(key, describeError(error));
    throw asKnownError("grant_volunteer_reward", error);
  }

  // Skips do NOT cache, and release the lock almost immediately so a future
  // retry can grant — see RETRYABLE_OUTCOME_KEEP_SECONDS for why the explicit
  // retention is load-bearing rather than cosmetic.
  if (outcome.kind === "skip") {
    await deps.idempotency.fail(
      key,
      outcome.skipped,
      RETRYABLE_OUTCOME_KEEP_SECONDS,
    );
    logger?.info("grantVolunteerReward.skipped", {
      rewardId: input.rewardId,
      signupId: input.signupId,
      reason: outcome.skipped,
    });
    return { ok: true, grantId: null, skipped: outcome.skipped };
  }

  const response: GrantVolunteerRewardOutput =
    outcome.kind === "already"
      ? { ok: true, grantId: outcome.grantId, skipped: "ALREADY_GRANTED" }
      : { ok: true, grantId: outcome.grantId };

  await deps.idempotency.commit<StoredGrant>(key, { response });

  // Post-commit delivery. The grant use case OWNS delivery (the comp path
  // sends nothing on its own). Failures are logged, never thrown — the grant
  // is already durable. Reuses the ticket.issued render/send path, which
  // emails the buyer's identity email. Shadow (guest) recipients carry an
  // AuthUser email from `ensureGuestHuman` but no real account yet, so their
  // comp email adds an `/auth/complete` claim link (mirrors the volunteer
  // signup email's `accountCompletionUrl`) to attach the ticket to an account.
  if (outcome.kind === "granted") {
    const mailDeps: SendTicketIssuedEmailDeps = {
      repos: deps.repos,
      mailer: deps.mailer,
      logger,
      reportError: deps.reportError,
    };
    const accountCompletionUrl = outcome.shadowClaimEmail
      ? `${deps.publicAppUrl.replace(/\/+$/, "")}/auth/complete?email=${encodeURIComponent(
          outcome.shadowClaimEmail,
        )}&src=volunteer-comp`
      : undefined;
    try {
      await sendTicketIssuedEmail(mailDeps, {
        orderId: outcome.compOrderId,
        publicAppUrl: deps.publicAppUrl,
        supportUrl: deps.supportUrl,
        ...(deps.tileServerUrl ? { tileServerUrl: deps.tileServerUrl } : {}),
        ...(accountCompletionUrl ? { accountCompletionUrl } : {}),
      });
    } catch (error) {
      logger?.error("grantVolunteerReward.email_failed", {
        grantId: outcome.grantId,
        compOrderId: outcome.compOrderId,
        error: describeError(error),
      });
      // The log line above already reaches Sentry via pinoIntegration; the
      // direct report adds the stack and the structured tags, and keeps the
      // swallow visible in composition roots that don't mount the log
      // integration (the seed script, jobs one-offs).
      try {
        deps.reportError?.(error, {
          tags: { useCase: "grantVolunteerReward", reason: "email_failed" },
          extra: {
            grantId: outcome.grantId,
            compOrderId: outcome.compOrderId,
          },
        });
      } catch {
        // Best-effort — the comp ticket is already minted and durable.
      }
    }
  }

  return response;
}

async function runGrantTransaction(
  deps: GrantVolunteerRewardDeps,
  input: { rewardId: string; signupId: string; trigger: string },
  logger: LoggerPort | undefined,
): Promise<TxOutcome> {
  const now = deps.clock.now();

  return deps.repos.tx(async (tx): Promise<TxOutcome> => {
    // Budget serialization point — locks the reward row until commit.
    const reward = await tx.volunteering.getRewardForUpdate(input.rewardId);
    if (!reward) {
      return { kind: "skip", skipped: "REWARD_NOT_FOUND" };
    }
    if (!reward.active) {
      return { kind: "skip", skipped: "INACTIVE" };
    }
    if (reward.maxGrants != null && reward.grantsUsed >= reward.maxGrants) {
      return { kind: "skip", skipped: "BUDGET_EXHAUSTED" };
    }

    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // Defensive re-check inside the lock: if a grant landed while we waited on
    // the reward lock, do not issue a second comp (the DB unique also guards).
    const existing = await tx.volunteering.getGrantByRewardAndSignup(
      input.rewardId,
      input.signupId,
    );
    if (existing) {
      return { kind: "already", grantId: existing.id };
    }

    // EVENT-subject asks only (2026-07-01 resolutions) — the reward's ticket
    // type belongs to the ask's event.
    const ask = await tx.volunteering.getAsk(reward.askId);
    if (!ask || ask.subjectType !== "EVENT") {
      throw fail("CONFLICT", {
        message: "reward_requires_event_ask",
        meta: { reason: "reward_requires_event_ask", rewardId: input.rewardId },
      });
    }
    const eventId = ask.subjectId;

    const ticketTypes = await tx.events.listTicketTypes(eventId);
    const ticketType = ticketTypes.find((tt) => tt.id === reward.ticketTypeId);
    if (!ticketType) {
      throw fail("TICKET_TYPE_NOT_FOUND");
    }

    // FR-004: resolved ONCE at the grant's `now`, so the grant row and its audit
    // entry can never disagree about what the comp was worth.
    const grantedFaceValueCents = resolveUnitPriceCents(ticketType, { now });

    // Resolve the recipient: the signup's own Human, else whoever owns
    // contactEmail. For a humanId-null signup (incl. a CONTACT-ONLY one —
    // an anonymous signup naming an email that already has an account) the
    // comp deliberately lands with the address's owner: the ticket email
    // goes to that inbox, so the rightful owner gets it and the person who
    // typed the address gets nothing. A brand-new address mints a shadow
    // profile. The grant's humanId stays the signup's (null here).
    const guest = signup.humanId
      ? null
      : await ensureGuestHumanKeepingName(tx.humans, {
          email: signup.contactEmail,
          name: signup.contactName ?? null,
        });
    const buyerHumanId = signup.humanId ?? guest!.humanId;
    // True only when THIS grant minted the recipient's profile — the one
    // case with no account to sign in to, and so the only one that gets an
    // account-claim link.
    const recipientMinted = guest?.created === true;

    // $0 COMP order + minted comp ticket via the existing ticketing path.
    const compOrderId = await createCompOrder(tx, {
      eventId,
      ticketTypeId: reward.ticketTypeId,
      quantity: 1,
      buyerHumanId,
      now,
    });

    const minted = await tx.tickets.listByOrderId(compOrderId);
    const ticketId = minted[0]?.id ?? null;

    const grant = await tx.volunteering.createGrant({
      rewardId: input.rewardId,
      signupId: input.signupId,
      humanId: signup.humanId ?? null,
      contactEmail: signup.contactEmail,
      compOrderId,
      ticketId,
      // FR-004: SNAPSHOT of the face value at grant time, resolved through the
      // one resolver at the grant's `now`. This is written once and never
      // recomputed (NFR-003) — but the value it snapshots must be the effective
      // price, or a comp granted after a scheduled flip records the stale one.
      faceValueCents: grantedFaceValueCents,
    });

    await tx.volunteering.incrementGrantsUsed(input.rewardId);

    await tx.audit.log({
      entity: "volunteer_reward_grant",
      entityId: grant.id,
      action: "volunteer_reward_granted",
      data: {
        rewardId: input.rewardId,
        signupId: input.signupId,
        trigger: input.trigger,
        compOrderId,
        ticketId,
        faceValueCents: grantedFaceValueCents,
        recipientHumanId: buyerHumanId,
        // A shadow profile was minted for this grant (no account yet).
        shadow: recipientMinted,
        // The signup had no Human, so the recipient was resolved by email.
        resolvedByEmail: signup.humanId == null,
      },
      at: now,
    });

    logger?.info("grantVolunteerReward.granted", {
      grantId: grant.id,
      rewardId: input.rewardId,
      signupId: input.signupId,
      compOrderId,
    });

    return {
      kind: "granted",
      grantId: grant.id,
      compOrderId,
      // Only a recipient this grant just minted gets an account-claim link;
      // an address that already had a Human (e.g. a contact-only signup's
      // account) already has a way in.
      shadowClaimEmail: recipientMinted ? signup.contactEmail : null,
    };
  });
}
