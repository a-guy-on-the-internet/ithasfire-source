import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { VolunteerGroupRecord } from "@th/ports/repos/volunteering";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { assignGroupCoordinatorInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type AssignGroupCoordinatorDeps = {
  repos: Repos;
  clock: ClockPort;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  /**
   * Public web origin for the coordinator link. Null (never "") when unset:
   * the notify leg is then skipped with one reported config warning instead
   * of feeding the strict renderer a non-URL link (mirrors
   * cancelShiftOccurrence).
   */
  appBaseUrl: string | null;
  /**
   * Budget for the per-actor daily cap on assigning a NEW address (the
   * shadow-profile path). Fails CLOSED: with no limiter, or a limiter that
   * errors, a new address is refused.
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  logger?: LoggerPort;
  /**
   * Reports a swallowed notify failure (the assignment is persisted, the
   * coordinator just isn't told). Optional + guarded: a throwing reporter
   * never changes the result.
   */
  reportError?: ReporterPort;
};

/**
 * Everything the post-commit "you're coordinating <group>" send needs,
 * collected inside the transaction so the notify call never re-opens repos
 * (mirrors the withdraw spot-opened convention in volunteer-signups.ts).
 */
type CoordinatorAssignedNotification = {
  recipientHumanId: string;
  payload: {
    askId: string;
    askTitle: string;
    groupId: string;
    groupName: string;
    coordinateUrl: string;
    accountCompletionUrl: string | null;
    assignerName: string | null;
  };
  scope: { kind: "ORG"; orgId: string } | { kind: "GLOBAL" };
};

/**
 * Liveness gate — mirrors create-volunteer-ask's HUMAN-subject check: a
 * suspended/banned human can't be handed coordination duties. Applied to
 * both resolution paths (coordinatorHumanId and an email that resolves to
 * an EXISTING account).
 */
function ensureCoordinatorIsActive(human: { status: string }): void {
  if (human.status === "SUSPENDED" || human.status === "BANNED") {
    throw fail("CONFLICT", {
      message: "human_not_active",
      meta: { reason: "human_not_active", status: human.status },
    });
  }
}

/**
 * The assigner's display name for the "who made you coordinator" line, or
 * null when there isn't a usable one. A name that looks like an email
 * address is dropped: shadow profiles have historically carried the address
 * in `name`, and an email must never be what the copy shows as a name.
 */
function displayNameForCopy(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.includes("@")) return null;
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

function normalizeBaseUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Per-actor daily ceiling on assigning coordinators by an email that has NO
 * account yet. Each such call mints a shadow Human + AuthUser, so without a
 * cap any signed-in user could create an ask + group and mint shadow
 * profiles for arbitrary addresses. The transport adds a per-actor hourly
 * limit on every call on top of this.
 */
export const COORDINATOR_NEW_EMAIL_DAILY_MAX = 20;
const COORDINATOR_NEW_EMAIL_WINDOW_SECONDS = 24 * 60 * 60;

export function coordinatorNewEmailDailyKey(actorHumanId: string): string {
  return `volunteer:assignCoordinator:newEmail:${actorHumanId}`;
}

function report(
  deps: Pick<AssignGroupCoordinatorDeps, "reportError">,
  error: unknown,
  tags: Record<string, string>,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "assignGroupCoordinator", ...tags },
      extra,
    });
  } catch {
    // Best-effort — a throwing reporter must never change the outcome.
  }
}

/**
 * Spend one unit of the actor's daily new-address budget, or throw
 * RATE_LIMITED. Fails CLOSED (like the waitlist mail caps): an unwired or
 * failing limiter refuses the new address, loudly.
 */
async function consumeNewEmailBudget(
  deps: Pick<AssignGroupCoordinatorDeps, "rateLimit" | "logger" | "reportError">,
  actorHumanId: string,
): Promise<void> {
  const refuse = (retryAfterSeconds: number | null) =>
    fail("RATE_LIMITED", {
      message:
        "You've invited the most new coordinators allowed for today. Try again tomorrow, or pick someone who already has an account.",
      meta: {
        scope: "coordinator_new_email_daily",
        ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
      },
    });

  if (!deps.rateLimit) {
    deps.logger?.error("volunteering.assignGroupCoordinator.new_email_cap_unwired", {
      actorHumanId,
    });
    report(
      deps,
      new Error("assignGroupCoordinator: rate limiter not wired — new-address coordinator refused"),
      { area: "coordinator_new_email_cap", reason: "limiter_unwired" },
      { actorHumanId },
    );
    throw refuse(null);
  }

  let allowed: boolean;
  let retryAfterSeconds = 0;
  try {
    const result = await deps.rateLimit.consume(
      coordinatorNewEmailDailyKey(actorHumanId),
      COORDINATOR_NEW_EMAIL_DAILY_MAX,
      COORDINATOR_NEW_EMAIL_WINDOW_SECONDS,
    );
    allowed = result.allowed;
    retryAfterSeconds = result.retryAfterSeconds;
  } catch (error) {
    deps.logger?.error(
      "volunteering.assignGroupCoordinator.new_email_cap_consume_failed",
      { actorHumanId, error: describeError(error) },
    );
    report(
      deps,
      error,
      { area: "coordinator_new_email_cap", reason: "consume_failed" },
      { actorHumanId },
    );
    throw refuse(null);
  }

  if (!allowed) {
    deps.logger?.warn("volunteering.assignGroupCoordinator.new_email_cap_hit", {
      actorHumanId,
    });
    throw refuse(retryAfterSeconds);
  }
}

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Set / replace / clear the single coordinator on a volunteer group
 * (FR-004, one_coordinator_v1).
 *
 * - OWNER-ONLY: authz is `resolveAskOwnership` on the group's ask —
 *   coordinators can never assign coordinators (spec
 *   `coordinator_scope.may_not`), including themselves.
 * - `coordinatorHumanId` assigns an existing Human (need not be an
 *   OrgMember); `coordinatorEmail` resolves via `ensureGuestHuman`, so a
 *   coordinator without an account gets a shadow profile. An address with
 *   no account spends the actor's daily new-address budget first
 *   (COORDINATOR_NEW_EMAIL_DAILY_MAX, fail-closed). Neither = clear.
 * - Invite flavor (accountCompletionUrl) is decided by the coordinator's
 *   ACCOUNT STATE, not by whether this call minted them: no verified email
 *   AND no linked auth account (credential or OAuth) = they still need to
 *   finish an account.
 * - Post-commit (never inside the tx): "<assigner> made you coordinator of
 *   <group>" via `deps.notify` — MailerPort + in-app Notification,
 *   respecting NotificationPreference exactly like the other volunteer
 *   sends. Only the NEW coordinator is told: never the assigner (an owner
 *   assigning themselves gets nothing), never a replaced coordinator (no
 *   "you were removed" notice exists anywhere in the pipeline), and never
 *   on a same-coordinator no-op. Failures (thrown, or an email leg that
 *   comes back `failed`) are logged + reported, never rolled back.
 */
export async function assignGroupCoordinator(
  deps: AssignGroupCoordinatorDeps,
  rawInput: unknown,
): Promise<VolunteerGroupRecord> {
  const input = parseInput(assignGroupCoordinatorInputSchema, rawInput);
  const baseUrl = normalizeBaseUrl(deps.appBaseUrl);

  // New-address cap, BEFORE the transaction so a refused call writes
  // nothing (no shadow Human, no AuthUser). A race where the address gains
  // an account in between only means one budget unit was spent needlessly.
  if (input.coordinatorEmail) {
    const existing = await deps.repos.humans.getByEmail(input.coordinatorEmail);
    if (!existing) {
      await consumeNewEmailBudget(deps, input.actorHumanId);
    }
  }

  const { updated, notification } = await deps.repos.tx(async (tx) => {
    const group = await tx.volunteering.getGroup(input.groupId);
    if (!group) {
      throw fail("NOT_FOUND", {
        message: "group_not_found",
        meta: { entity: "volunteer_group" },
      });
    }

    const ask = await tx.volunteering.getAsk(group.askId);
    if (!ask) {
      throw fail("NOT_FOUND", {
        message: "ask_not_found",
        meta: { entity: "volunteer_ask" },
      });
    }

    await resolveAskOwnership(tx, ask, input.actorHumanId);

    if (ask.status === "ARCHIVED") {
      throw fail("CONFLICT", {
        message: "ask_archived",
        meta: { reason: "ask_archived" },
      });
    }

    // Resolve the target coordinator (null = clear).
    let coordinatorHumanId: string | null = null;

    if (input.coordinatorHumanId) {
      const human = await tx.humans.getById(input.coordinatorHumanId);
      if (!human) {
        throw fail("HUMAN_NOT_FOUND");
      }
      ensureCoordinatorIsActive(human);
      coordinatorHumanId = human.id;
    } else if (input.coordinatorEmail) {
      // No `name`: on the existing-account branch ensureGuestHuman would
      // RENAME that person's profile to whatever is passed, and passing the
      // address wrote their email into Human.name — which the ask owner's
      // roster renders, undoing the "owner never sees the coordinator's
      // email" rule. A fresh shadow profile stays unnamed until its owner
      // completes their account.
      const guest = await tx.humans.ensureGuestHuman({
        email: input.coordinatorEmail,
      });
      if (!guest.created) {
        // The email resolved to an EXISTING account — apply the same
        // liveness gate as the coordinatorHumanId path. Freshly created
        // shadow humans are ACTIVE by construction, so no extra read there.
        const human = await tx.humans.getById(guest.humanId);
        if (!human) {
          throw fail("HUMAN_NOT_FOUND");
        }
        ensureCoordinatorIsActive(human);
      }
      coordinatorHumanId = guest.humanId;
    }

    // Idempotent no-op: same coordinator (or already clear) — don't re-send
    // the assignment email.
    if (group.coordinatorHumanId === coordinatorHumanId) {
      return { updated: group, notification: null };
    }

    // Compare-and-swap on the coordinator we just read: a concurrent
    // double-submit of the same change loses here (0 rows) and takes the
    // no-op branch, so only one write — and one notice — happens.
    const swapped = await tx.volunteering.setGroupCoordinatorIfCurrent(
      input.groupId,
      group.coordinatorHumanId,
      coordinatorHumanId,
    );
    if (!swapped) {
      const current = await tx.volunteering.getGroup(input.groupId);
      if (current && current.coordinatorHumanId === coordinatorHumanId) {
        // Lost to an identical concurrent write: the outcome the caller
        // asked for already holds, and its winner sent the one notice.
        return { updated: current, notification: null };
      }
      // The group was deleted between our read and our write. The throw
      // also rolls back anything this call minted (e.g. a shadow profile).
      if (!current) {
        throw fail("NOT_FOUND", {
          message: "group_not_found",
          meta: { entity: "volunteer_group" },
        });
      }
      // Someone set a DIFFERENT coordinator between our read and our write.
      // Don't silently report success for a change that didn't happen.
      throw fail("CONFLICT", {
        message: "coordinator_changed",
        meta: { reason: "coordinator_changed" },
      });
    }
    const updated = swapped;

    // Tell the new coordinator — unless there is none (a clear) or the
    // owner assigned themselves (they already know).
    const shouldNotify =
      coordinatorHumanId !== null && coordinatorHumanId !== input.actorHumanId;

    // Invite flavor from account state (see the doc comment). Only read
    // when a notice will actually go out.
    let inviteEmail: string | null = null;
    if (shouldNotify && coordinatorHumanId) {
      const withIdentity = await tx.humans.getByIdWithIdentity(coordinatorHumanId);
      if (withIdentity && !withIdentity.identity.emailVerified) {
        const accounts = await tx.humans.listAuthAccounts(coordinatorHumanId);
        if (accounts.length === 0) {
          inviteEmail = withIdentity.identity.email;
        }
      }
    }
    const invited = inviteEmail !== null;

    await tx.audit.log({
      entity: "volunteer_group",
      entityId: input.groupId,
      action: coordinatorHumanId ? "coordinator_assigned" : "coordinator_cleared",
      data: {
        askId: group.askId,
        coordinatorHumanId,
        previousCoordinatorHumanId: group.coordinatorHumanId,
        actorHumanId: input.actorHumanId,
        ...(invited ? { invited: true } : {}),
      },
      at: deps.clock.now(),
    });

    const assignerName = shouldNotify && baseUrl
      ? displayNameForCopy(
          (await tx.humans.getById(input.actorHumanId))?.name ?? null,
        )
      : null;

    const notification: CoordinatorAssignedNotification | null =
      shouldNotify && coordinatorHumanId && baseUrl
        ? {
            recipientHumanId: coordinatorHumanId,
            payload: {
              askId: ask.id,
              askTitle: ask.title,
              groupId: group.id,
              groupName: group.name,
              coordinateUrl: `${baseUrl}/volunteers/coordinate/${ask.id}`,
              accountCompletionUrl: inviteEmail
                ? `${baseUrl}/auth/complete?email=${encodeURIComponent(inviteEmail)}&src=volunteer-coordinator`
                : null,
              assignerName,
            },
            scope: ask.orgId
              ? { kind: "ORG", orgId: ask.orgId }
              : { kind: "GLOBAL" },
          }
        : null;

    if (shouldNotify && !baseUrl) {
      deps.logger?.error(
        "volunteering.assignGroupCoordinator.notify_skipped_no_base_url",
        { groupId: updated.id, coordinatorHumanId },
      );
      report(
        deps,
        new Error("assignGroupCoordinator: appBaseUrl unset — coordinator notice skipped"),
        { stage: "notify", reason: "no_base_url" },
        { groupId: updated.id },
      );
    }

    return { updated, notification };
  });

  // Post-commit notification. Mail failures must NOT roll back (or appear
  // to fail) the assignment — mirror submit/review/withdraw.
  if (notification) {
    const reportFailure = (error: unknown, reason: string) => {
      // ERROR (not warn): the assignment IS persisted but the coordinator
      // won't learn about it. Logged for Cloud Logging, reported for Sentry.
      deps.logger?.error("volunteering.assignGroupCoordinator.notify_failed", {
        groupId: updated.id,
        coordinatorHumanId: notification.recipientHumanId,
        reason,
        error: describeError(error),
      });
      report(
        deps,
        error,
        { reason },
        {
          groupId: updated.id,
          askId: notification.payload.askId,
          coordinatorHumanId: notification.recipientHumanId,
        },
      );
    };

    // B2: the seat can be given BY EMAIL to an existing account, so an
    // unverified coordinator may be an account someone else opened under the
    // address. The notice still reaches that inbox (with its link); in-app
    // and push only a verified account. A fresh shadow is unverified too and
    // has no session, so email is all it can read anyway.
    const verified = await loadVerifiedRecipientIds({
      humans: deps.repos.humans,
      humanIds: [notification.recipientHumanId],
      onLookupFailed: (error) => {
        deps.logger?.error(
          "volunteering.assignGroupCoordinator.verified_lookup_failed",
          {
            groupId: updated.id,
            coordinatorHumanId: notification.recipientHumanId,
            error: describeError(error),
          },
        );
        report(
          deps,
          error,
          { stage: "verified_lookup" },
          {
            groupId: updated.id,
            coordinatorHumanId: notification.recipientHumanId,
          },
        );
      },
    });

    try {
      const result = await deps.notify({
        ...channelsForRecipient(verified, notification.recipientHumanId),
        humanId: notification.recipientHumanId,
        variant: "volunteer.group-coordinator-assigned",
        payload: notification.payload,
        scope: notification.scope,
        // Per ASSIGNMENT, not per (group, human) pair: the row's updatedAt
        // changes on every coordinator write, so re-adding a removed
        // coordinator (A→B→A) is a new notice, and a payload that differs
        // between assignments (e.g. the invite link) can't collide with an
        // earlier one's stored hash (IDEMPOTENCY_KEY_CONFLICT) or with a
        // provider-side dedupe window on the derived `:email` key.
        idempotencyKey: `${updated.id}:coordinator-assigned:${notification.recipientHumanId}:${updated.updatedAt.toISOString()}`,
      });
      // notify() does not throw when the mailer fails — the email channel
      // comes back `failed` and only logs at warn (invisible to Sentry).
      if (result.email?.status === "failed") {
        reportFailure(
          new Error(`coordinator_assigned_email_failed:${result.email.reason}`),
          "email_failed",
        );
      }
    } catch (error) {
      reportFailure(error, "notify_failed");
    }
  }

  return updated;
}
