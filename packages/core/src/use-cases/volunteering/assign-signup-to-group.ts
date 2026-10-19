import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerGroupRecord,
  VolunteerSignupRecord,
} from "@th/ports/repos/volunteering";
import { fail, isAppError } from "@th/errors";

import { describeError, parseInput } from "../../lib/io";
import {
  channelsForRecipient,
  loadVerifiedRecipientIds,
} from "../../lib/verified-recipients";
import type { NotifyInput, NotifyOutput } from "../comms/notify";
import {
  ensureCoordinatorEmailVerified,
  OWNERSHIP_DENIAL_CODES,
} from "./_shared/require-coordinator-or-owner";
import { resolveAskOwnership } from "./_shared/resolve-ask-ownership";
import { assignSignupToGroupInputSchema } from "./schemas";

// ── Deps ────────────────────────────────────────────────────────────────────

export type AssignSignupToGroupDeps = {
  repos: Repos;
  clock: ClockPort;
  notify: (input: NotifyInput) => Promise<NotifyOutput>;
  appBaseUrl: string;
  logger?: LoggerPort;
  /** Guarded Sentry reporting for the verified-lookup swallow below. */
  reportError?: ReporterPort;
};

/**
 * Post-commit "a signup landed in your group" send, collected in-tx
 * (mirrors the coordinator-assigned convention in assign-group-coordinator).
 */
type GroupSignupAssignedNotification = {
  recipientHumanId: string;
  payload: {
    askId: string;
    askTitle: string;
    groupId: string;
    groupName: string;
    signupId: string;
    roleName: string;
    volunteerName: string;
    coordinateUrl: string;
  };
  scope: { kind: "ORG"; orgId: string } | { kind: "GLOBAL" };
};

/**
 * Move a signup into / between / out of (null) a group (FR-005,
 * `signup_assignment`). Assignment is separate from approval — approved
 * unassigned signups sit in the ask's general pool.
 *
 * Authorization (spec `coordinator_scope`):
 * - Ask OWNER (`resolveAskOwnership`): any move.
 * - COORDINATOR: exactly two moves, both anchored on THEIR OWN group —
 *   pull an APPROVED pool signup (`groupId: null`) INTO their group, or
 *   release a member of their group back to the pool. Never into/out of
 *   another group; a cross-group attempt gets the same `forbidden` as any
 *   non-owner (never a 404 — spec acceptance criterion).
 *
 * Invariants enforced in the same tx as the move (NFR-002):
 * - the target group must belong to the SAME ask as the signup,
 * - group capacity (when set) is checked against the group's accepted
 *   member count (APPROVED | CHECKED_IN) — soft cap, same fidelity note as
 *   the ask-level cap in volunteer-signups.
 *
 * Idempotent no-op when the signup is already where it's being moved.
 * Audit-logs every real move with the acting capacity.
 */
export async function assignSignupToGroup(
  deps: AssignSignupToGroupDeps,
  rawInput: unknown,
): Promise<VolunteerSignupRecord> {
  const input = parseInput(assignSignupToGroupInputSchema, rawInput);

  const { updated, notification } = await deps.repos.tx(async (tx) => {
    const signup = await tx.volunteering.getSignup(input.signupId);
    if (!signup) {
      throw fail("SIGNUP_NOT_FOUND");
    }
    // Groups hang off asks — a signup without an ask (legacy pre-backfill
    // row) can't be grouped. SIGNUP_NOT_FOUND, not a specific error:
    // probing ids must never confirm existence (anti-oracle rule shared
    // with review/check-in).
    if (!signup.askId) {
      throw fail("SIGNUP_NOT_FOUND");
    }
    const ask = await tx.volunteering.getAsk(signup.askId);
    if (!ask) {
      throw fail("SIGNUP_NOT_FOUND");
    }

    // ── Authorize + resolve the target group ─────────────────────────────
    let via: "owner" | "coordinator";
    let targetGroup: VolunteerGroupRecord | null = null;

    try {
      await resolveAskOwnership(tx, ask, input.actorHumanId);
      via = "owner";
    } catch (error) {
      if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
        throw error;
      }
      // Coordinator legs. The group whose coordinator seat matters is the
      // one being entered (pull), left (release), or — for the idempotent
      // same-group no-op — the group itself. Loaded fresh in this tx so a
      // just-revoked coordinator can't act on a stale grant.
      const coordinatedGroupId =
        signup.groupId === null
          ? input.groupId // pull from pool
          : input.groupId === null
            ? signup.groupId // release to pool
            : input.groupId === signup.groupId
              ? signup.groupId // same-group no-op
              : null; // group → group: owner only
      // Cross-group moves (and probes on foreign signups) stay owner-only:
      // rethrow the ORIGINAL denial so a cross-group coordinator is
      // indistinguishable from a stranger (forbidden, never 404).
      if (!coordinatedGroupId) {
        throw error;
      }
      const group = await tx.volunteering.getGroup(coordinatedGroupId);
      if (
        !group ||
        group.askId !== ask.id ||
        group.coordinatorHumanId === null ||
        group.coordinatorHumanId !== input.actorHumanId
      ) {
        throw error;
      }
      await ensureCoordinatorEmailVerified(tx, input.actorHumanId);
      via = "coordinator";
      if (input.groupId) {
        targetGroup = group;
      }
    }

    // Owner path (or coordinator release): resolve/validate the target.
    if (input.groupId && !targetGroup) {
      const group = await tx.volunteering.getGroup(input.groupId);
      // Foreign-ask groups 404 uniformly — never confirm they exist.
      if (!group || group.askId !== ask.id) {
        throw fail("NOT_FOUND", {
          message: "group_not_found",
          meta: { entity: "volunteer_group" },
        });
      }
      targetGroup = group;
    }

    // Idempotent no-op — nothing moved, no audit, no notification.
    if (signup.groupId === input.groupId) {
      return { updated: signup, notification: null };
    }

    // Coordinator pull rule: only APPROVED pool signups may be pulled
    // (FR-005 — "unassigned approved signups"). Enforced after authz and
    // the no-op return so status errors never double as a probe.
    if (via === "coordinator" && input.groupId && signup.status !== "APPROVED") {
      throw fail("CONFLICT", {
        message: "signup_not_approved",
        meta: { reason: "signup_not_approved" },
      });
    }

    // Group capacity (soft cap): accepted members only, counted via the
    // group-scoped list primitive in the same tx.
    if (targetGroup && targetGroup.capacity != null) {
      const [approved, checkedIn] = await Promise.all([
        tx.volunteering.listSignupsByAsk(ask.id, {
          groupId: targetGroup.id,
          status: "APPROVED",
          limit: 1,
        }),
        tx.volunteering.listSignupsByAsk(ask.id, {
          groupId: targetGroup.id,
          status: "CHECKED_IN",
          limit: 1,
        }),
      ]);
      if (
        approved.pageInfo.total + checkedIn.pageInfo.total >=
        targetGroup.capacity
      ) {
        throw fail("CONFLICT", {
          message: "group_full",
          meta: { reason: "group_full" },
        });
      }
    }

    const updated = await tx.volunteering.assignSignupToGroup(
      signup.id,
      input.groupId,
    );

    await tx.audit.log({
      entity: "volunteer_signup",
      entityId: signup.id,
      action: input.groupId ? "assigned_to_group" : "released_to_pool",
      data: {
        askId: ask.id,
        fromGroupId: signup.groupId,
        toGroupId: input.groupId,
        actorHumanId: input.actorHumanId,
        via,
      },
      at: deps.clock.now(),
    });

    // FR-008: the receiving group's coordinator hears about the arrival —
    // unless they made the move themselves.
    let notification: GroupSignupAssignedNotification | null = null;
    if (
      targetGroup?.coordinatorHumanId &&
      targetGroup.coordinatorHumanId !== input.actorHumanId
    ) {
      const role = await tx.volunteering.getEventRole(signup.roleId);
      notification = {
        recipientHumanId: targetGroup.coordinatorHumanId,
        payload: {
          askId: ask.id,
          askTitle: ask.title,
          groupId: targetGroup.id,
          groupName: targetGroup.name,
          signupId: signup.id,
          roleName: role?.name ?? "Volunteer",
          volunteerName: signup.contactName ?? signup.contactEmail,
          coordinateUrl: `${deps.appBaseUrl}/volunteers/coordinate/${ask.id}`,
        },
        scope: ask.orgId
          ? { kind: "ORG", orgId: ask.orgId }
          : { kind: "GLOBAL" },
      };
    }

    return { updated, notification };
  });

  // Post-commit — failures logged, never rolled back (house convention).
  if (notification) {
    // B2: a coordinator seat can be given BY EMAIL to an existing account, so
    // an unverified coordinator may be someone else's account. The notice
    // still reaches the address's inbox; in-app and push only a verified one.
    const { recipientHumanId } = notification;
    const verified = await loadVerifiedRecipientIds({
      humans: deps.repos.humans,
      humanIds: [recipientHumanId],
      onLookupFailed: (error) => {
        deps.logger?.error(
          "volunteering.assignSignupToGroup.verified_lookup_failed",
          { signupId: updated.id, recipientHumanId, error: describeError(error) },
        );
        deps.reportError?.(error, {
          tags: { useCase: "assignSignupToGroup", stage: "verified_lookup" },
          extra: { signupId: updated.id, recipientHumanId },
        });
      },
    });
    try {
      await deps.notify({
        humanId: recipientHumanId,
        variant: "volunteer.group-signup-assigned",
        payload: notification.payload,
        scope: notification.scope,
        idempotencyKey: `${updated.id}:group-assigned:${notification.payload.groupId}`,
        ...channelsForRecipient(verified, recipientHumanId),
      });
    } catch (error) {
      deps.logger?.error("volunteering.assignSignupToGroup.notify_failed", {
        signupId: updated.id,
        groupId: notification.payload.groupId,
        recipientHumanId: notification.recipientHumanId,
        error: describeError(error),
      });
    }
  }

  return updated;
}
