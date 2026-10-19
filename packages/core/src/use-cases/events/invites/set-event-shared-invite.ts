import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventInviteRecord, EventRecord } from "@th/ports/repos/events";

import { describeError, parseInput } from "../../../lib/io";
import {
  hashInviteToken,
  mintInviteToken,
} from "../../../lib/security/invite-token";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";
import {
  isStatusConflict,
  isTransactionDeadlockOrSerialization,
} from "../_shared/status-conflict";
import {
  assertEventTakesNewInvites,
  assertInviteConfig,
  buildInviteUrl,
  hasErrorCode,
  type InviteLinkConfig,
} from "./_shared";
import { rescindInviteApprovals } from "./rescind-invite-approvals";

/**
 * Turn on / reset / turn off the event's SHARED invite link
 * (gated-event invite links FR-001, R5, R6).
 *
 * - ENABLE: returns the live link if there is one (idempotent), else mints it.
 * - RESET: revokes the live link and mints a new one in one adapter
 *   transaction (`rotateShared`). People already in stay in (R5).
 * - DISABLE: revokes the live link, leaving none. Allowed on any event so an
 *   organizer can still turn a link off after removing the gate.
 * - RESET_AND_REMOVE ("Reset and remove everyone", owner ruling 2026-10-05,
 *   for a leaked link): RESET, plus everyone who got in through ANY earlier
 *   SHARED link of this event is removed. Phase 1, in the SAME transaction
 *   as the rotation: `grantsRevokedAt` is stamped on every earlier SHARED
 *   row (so their `th_ei_` cookies stop holding on the next read), and every
 *   EventUnlock carrying one of those invite ids is revoked (signed-in
 *   holders, including invite-approved ones). Phase 2, after the commit:
 *   each earlier link's still-APPROVED invite approvals are rescinded through
 *   the guarded path shared with revoking a personal invite
 *   (`rescindInviteApprovals`; best-effort, reported). Personal invites and
 *   what they granted are untouched. Re-running it repairs a phase 2 that
 *   stopped short, at the cost of minting another new link.
 *   NAMED GUESTS stay in (fix round 1): a signed-in holder whose VERIFIED
 *   account email has a live PERSONAL invite on this event, but who first
 *   came in through the shared link, has their unlock (and the approval it
 *   came from) re-pointed to their own invite in phase 1, before
 *   `revokeByInvite` runs. From then on their access lives and dies with
 *   their personal invite. Signed-out `th_ei_` holders can't be matched to
 *   an email; they open their personal link again.
 *   It also works while the event no longer takes new invites (gate off,
 *   ended, cancelled; security review N8): people are removed regardless.
 *   A new link is minted only when the event takes new invites AND a shared
 *   link was live; otherwise the live one (if any) is turned off and the
 *   link stays off (so after a DISABLE it stays disabled).
 *
 * A concurrent ENABLE/RESET that loses the one-live-SHARED unique index
 * (`shared_invite_already_live`) is not an error to the organizer: the
 * winner's link is live, so this re-reads and returns it.
 */

export const setEventSharedInviteInputSchema = z
  .object({
    eventId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    action: z.enum(["ENABLE", "RESET", "RESET_AND_REMOVE", "DISABLE"]),
  })
  .strict();

export const setEventSharedInviteOutputSchema = z
  .object({
    /** The live link's id; after DISABLE, the id that was turned off (or null). */
    id: z.string().uuid().nullable(),
    /** Full URL to copy; null after DISABLE. */
    url: z.string().nullable(),
    /**
     * RESET_AND_REMOVE only (absent otherwise): earlier SHARED links whose
     * grants were ended, signed-in unlocks revoked, and invite approvals
     * rescinded.
     */
    removed: z
      .object({
        links: z.number().int().nonnegative(),
        unlocksRevoked: z.number().int().nonnegative(),
        submissionsRescinded: z.number().int().nonnegative(),
        /** Named guests kept (re-pointed to their own PERSONAL invite). */
        namedGuestsKept: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SetEventSharedInviteInput = z.infer<
  typeof setEventSharedInviteInputSchema
>;
export type SetEventSharedInviteOutput = z.infer<
  typeof setEventSharedInviteOutputSchema
>;

export type SetEventSharedInviteDeps = InviteLinkConfig & {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /** RESET_AND_REMOVE's phase-2 rescind failures are swallowed and reported. */
  reportError?: ReporterPort;
};

const USE_CASE = "setEventSharedInvite";

export async function setEventSharedInvite(
  deps: SetEventSharedInviteDeps,
  rawInput: unknown,
): Promise<SetEventSharedInviteOutput> {
  const input = parseInput(setEventSharedInviteInputSchema, rawInput);
  const event = await ensureActorCanEditEvent(
    deps.repos,
    input.eventId,
    input.actorHumanId,
  );
  const now = deps.clock.now();

  if (input.action === "DISABLE") {
    const revoked = await deps.repos.tx(async (tx) => {
      const live = await tx.eventInvites.getLiveShared(event.id);
      if (!live) return null;
      await tx.eventInvites.revoke(live.id, now);
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "event_shared_invite_disabled",
        data: { actorHumanId: input.actorHumanId, inviteId: live.id },
        at: now,
      });
      return live;
    });
    return setEventSharedInviteOutputSchema.parse({
      id: revoked?.id ?? null,
      url: null,
    });
  }

  if (input.action === "RESET_AND_REMOVE") {
    // Removal must work whatever state the event is in (N8); only minting
    // the replacement link depends on it taking new invites.
    return resetAndRemove(deps, {
      event,
      actorHumanId: input.actorHumanId,
      now,
    });
  }

  assertEventTakesNewInvites(event, now);
  assertInviteConfig(deps);

  const respond = (invite: EventInviteRecord) =>
    setEventSharedInviteOutputSchema.parse({
      id: invite.id,
      url: buildInviteUrl(deps, event, invite.id),
    });

  if (input.action === "ENABLE") {
    const live = await deps.repos.eventInvites.getLiveShared(event.id);
    if (live) return respond(live);
  }

  const id = randomUUID();
  const next = {
    id,
    tokenHash: hashInviteToken(mintInviteToken(id, deps.inviteTokenSecret)),
    createdByHumanId: input.actorHumanId,
  };

  try {
    const created = await deps.repos.tx(async (tx) => {
      const result =
        input.action === "RESET"
          ? await tx.eventInvites.rotateShared(event.id, next, now)
          : {
              revoked: null,
              created: await tx.eventInvites.create({
                ...next,
                eventId: event.id,
                kind: "SHARED",
              }),
            };
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action:
          input.action === "RESET"
            ? "event_shared_invite_reset"
            : "event_shared_invite_enabled",
        data: {
          actorHumanId: input.actorHumanId,
          inviteId: result.created.id,
          revokedInviteId: result.revoked?.id ?? null,
        },
        at: now,
      });
      return result.created;
    });
    deps.logger?.info("event_gate", {
      category: "event_gate",
      eventId: event.id,
      action: `shared_invite_${input.action.toLowerCase()}`,
      result: "success",
      actorHumanId: input.actorHumanId,
      metadata: { inviteId: created.id },
    });
    return respond(created);
  } catch (error) {
    // Lost the race to a concurrent ENABLE/RESET. That transaction rolled
    // back whole (Postgres aborts it on the unique violation), so the
    // re-read runs outside it.
    if (!hasErrorCode(error, "shared_invite_already_live")) throw error;
    const winner = await deps.repos.eventInvites.getLiveShared(event.id);
    if (!winner) throw error;
    return respond(winner);
  }
}

/** {@link assertEventTakesNewInvites} as a yes/no. */
function eventTakesNewInvites(event: EventRecord, now: Date): boolean {
  try {
    assertEventTakesNewInvites(event, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * RESET_AND_REMOVE (see the header). A concurrent ENABLE/RESET winning the
 * one-live-SHARED index rolls this whole transaction back, removal included,
 * so it is surfaced, not papered over: the organiser asked for a removal
 * that did not happen, and pressing it again does it.
 */
async function resetAndRemove(
  deps: SetEventSharedInviteDeps,
  args: { event: EventRecord; actorHumanId: string; now: Date },
): Promise<SetEventSharedInviteOutput> {
  const { event, actorHumanId, now } = args;
  const eventId = event.id;
  const takesNew = eventTakesNewInvites(event, now);
  let next: { id: string; tokenHash: string; createdByHumanId: string } | null =
    null;
  if (takesNew) {
    assertInviteConfig(deps);
    const id = randomUUID();
    next = {
      id,
      tokenHash: hashInviteToken(mintInviteToken(id, deps.inviteTokenSecret)),
      createdByHumanId: actorHumanId,
    };
  }

  // Lock order here is shared invites → personal invite → unlock →
  // submission, which can cycle with a concurrent redeem (personal invite →
  // submission → approving shared invite) or persist (submission → approving
  // shared invite). Postgres breaks the cycle by aborting one side; this
  // whole transaction rolled back, so it runs once more (same posture as
  // redeem's `withOneRetry`). `next` was minted outside, so the retry
  // inserts the same new link id. A second loss propagates.
  const runPhase1 = () => deps.repos.tx(async (tx) => {
    const live = await tx.eventInvites.getLiveShared(eventId);
    // Mint only when the event takes invites AND the link was on: after a
    // DISABLE (or with the gate off) the link stays off.
    let created: EventInviteRecord | null = null;
    let revokedId: string | null = null;
    if (next && live) {
      const rotated = await tx.eventInvites.rotateShared(eventId, next, now);
      created = rotated.created;
      revokedId = rotated.revoked?.id ?? null;
    } else if (live) {
      await tx.eventInvites.revoke(live.id, now);
      revokedId = live.id;
    }
    // Every SHARED row but the new one: the one just rotated out, links
    // reset or turned off earlier, and any a previous removal stamped
    // (re-revoking their unlocks is a no-op, and they get phase 2 again).
    const oldIds = await tx.eventInvites.revokeSharedGrants(
      eventId,
      now,
      created ? { exceptInviteId: created.id } : undefined,
    );
    const namedGuestsKept = await keepNamedGuests(tx, {
      eventId,
      oldIds,
      now,
    });
    let unlocksRevoked = 0;
    for (const oldId of oldIds) {
      unlocksRevoked += await tx.eventUnlocks.revokeByInvite(oldId, now);
    }
    await tx.audit.log({
      entity: "event",
      entityId: eventId,
      action: "event_shared_invite_reset_and_removed",
      data: {
        actorHumanId,
        inviteId: created?.id ?? null,
        revokedInviteId: revokedId,
        removedInviteIds: oldIds,
        unlocksRevoked,
        namedGuestsKept,
      },
      at: now,
    });
    return { created, revokedId, oldIds, unlocksRevoked, namedGuestsKept };
  });
  let phase1: Awaited<ReturnType<typeof runPhase1>>;
  try {
    phase1 = await runPhase1();
  } catch (error) {
    if (!isTransactionDeadlockOrSerialization(error)) throw error;
    deps.logger?.warn(`events.${USE_CASE}.reset_and_remove_retry`, {
      eventId,
      error: describeError(error),
    });
    phase1 = await runPhase1();
  }

  let submissionsRescinded = 0;
  for (const oldId of phase1.oldIds) {
    const result = await rescindInviteApprovals(deps, {
      eventId,
      inviteId: oldId,
      actorHumanId,
      useCase: USE_CASE,
      auditData: { viaSharedInviteRemoval: oldId },
    });
    submissionsRescinded += result.submissionsRescinded;
  }

  const removed = {
    links: phase1.oldIds.length,
    unlocksRevoked: phase1.unlocksRevoked,
    submissionsRescinded,
    namedGuestsKept: phase1.namedGuestsKept,
  };
  deps.logger?.info("event_gate", {
    category: "event_gate",
    eventId,
    action: "shared_invite_reset_and_remove",
    result: "success",
    actorHumanId,
    metadata: { inviteId: phase1.created?.id ?? null, ...removed },
  });
  return setEventSharedInviteOutputSchema.parse({
    id: phase1.created?.id ?? phase1.revokedId,
    url: phase1.created ? buildInviteUrl(deps, event, phase1.created.id) : null,
    removed,
  });
}

/**
 * Phase-1 step of RESET_AND_REMOVE: keep the NAMED guests among the people
 * the old shared links let in. A named guest is a signed-in holder of a
 * live unlock from one of `oldIds` whose account email is VERIFIED and
 * equals (case-insensitively) the email of a live PERSONAL invite on this
 * event. For each one:
 *  - the personal invite's row lock is taken (`lockIfLive`), so a revoke of
 *    that invite either committed first (skip: they go with the rest) or
 *    waits for this commit and its `revokeByInvite` then sees the moved row;
 *  - their unlock is re-pointed to the personal invite (guarded write);
 *  - when the unlock came from an approval still stamped with the old
 *    shared link, that approval is re-stamped with the personal invite
 *    (status + invite CAS), so phase 2 doesn't rescind it and the read path
 *    checks it against the personal invite.
 * Bounded reads: the event's unlocks and invites, one batch email lookup,
 * then one identity read per CANDIDATE (holders whose account email matched
 * a personal invite), not per holder.
 */
async function keepNamedGuests(
  tx: TxRepos,
  args: { eventId: string; oldIds: string[]; now: Date },
): Promise<number> {
  const { eventId, oldIds, now } = args;
  if (oldIds.length === 0) return 0;
  const old = new Set(oldIds);
  const held = (await tx.eventUnlocks.listByEventId(eventId)).filter(
    (u) =>
      u.revokedAt === null &&
      (u.expiresAt === null || u.expiresAt.getTime() > now.getTime()) &&
      u.inviteId !== null &&
      old.has(u.inviteId),
  );
  if (held.length === 0) return 0;

  const personalByEmail = new Map<string, string>();
  for (const invite of await tx.eventInvites.listByEvent(eventId)) {
    if (invite.kind !== "PERSONAL" || invite.revokedAt || !invite.inviteeEmail) {
      continue;
    }
    personalByEmail.set(invite.inviteeEmail.trim().toLowerCase(), invite.id);
  }
  if (personalByEmail.size === 0) return 0;

  const humanByEmail = await tx.humans.batchLookupHumanIdsByEmail([
    ...personalByEmail.keys(),
  ]);
  const candidates = new Set(humanByEmail.values());

  let kept = 0;
  for (const unlock of held) {
    if (!candidates.has(unlock.humanId)) continue;
    const who = await tx.humans.getByIdWithIdentity(unlock.humanId);
    const email = who?.identity?.email?.trim().toLowerCase();
    if (!email || !who?.identity?.emailVerified) continue;
    const personalId = personalByEmail.get(email);
    if (!personalId) continue;
    if (!(await tx.eventInvites.lockIfLive(personalId))) continue;

    // Read before the write: the record may be live (fakes hand back rows).
    const fromInviteId = unlock.inviteId;
    const submissionId = unlock.applicationSubmissionId;
    const moved = await tx.eventUnlocks.repointInvite({
      eventId,
      humanId: unlock.humanId,
      fromInviteIds: oldIds,
      toInviteId: personalId,
    });
    if (!moved) continue;
    if (submissionId) {
      try {
        await tx.eventApplications.updateSubmissionStatus({
          submissionId,
          status: "APPROVED",
          inviteId: personalId,
          expectedFromStatuses: ["APPROVED"],
          expectedInviteId: fromInviteId,
        });
      } catch (error) {
        // The approval moved on (rescinded, re-decided, or not this link's):
        // nothing to re-stamp. The guarded write changed nothing, so the
        // transaction is still good.
        if (!isStatusConflict(error)) throw error;
      }
    }
    kept += 1;
  }
  return kept;
}
