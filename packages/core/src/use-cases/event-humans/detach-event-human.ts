import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import {
  actOfLineupRow,
  lockPicksBehindLineupRow,
  settlePicksAfterLineupExit,
} from "../events/open-calls/_shared/open-call-decision";
import { fail } from "@th/errors";

export const detachEventHumanInput = z.object({
  actorHumanId: z.uuid(),
  eventHumanId: z.uuid(),
});

export type DetachEventHumanInput = z.infer<typeof detachEventHumanInput>;

export type DetachEventHumanDeps = {
  repos: Repos;
  /**
   * Admits a community moderator to an ownerless listing's lineup — see
   * {@link ensureOwnerOrCommunityModerator}. Required, not optional: an
   * omitted probe would fail closed and silently refuse every lineup write
   * on a community listing.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * An editor removes a lineup row. The existing removal behaviour and notice
 * are unchanged.
 *
 * Open calls (spec 2026-10-05 FR-019): when the row is an act picked through
 * an open call, the APPROVED application records removedFromLineupAt in the
 * same transaction; its status stays APPROVED, so the history stays true.
 * Series pick for several nights: stamped only when the act has NO row left
 * on the nights they chose (removing one of three keeps the stamp off; the
 * lineup shows the rest). Lock order: the application row first, then the
 * row delete.
 */
export async function detachEventHuman(
  deps: DetachEventHumanDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(detachEventHumanInput, rawInput);

  await deps.repos.tx(async (tx) => {
    const record = await tx.eventHumans.getById(input.eventHumanId);
    if (!record) {
      throw fail("EVENT_HUMAN_NOT_FOUND");
    }

    const event = await ensureEventExists(tx, record.eventId);
    await ensureOwnerOrCommunityModerator(
      { repos: tx, authz: deps.authz },
      event,
      input.actorHumanId,
    );

    const now = deps.clock.now();
    const act = actOfLineupRow(record);
    const picks = act
      ? await lockPicksBehindLineupRow(tx, { eventId: record.eventId, act })
      : [];
    // Re-read AFTER the lock: a concurrent removal or leave that won while
    // we waited answers the same not-found as above, never a raw P2025 from
    // the delete. Uncontended, the row is simply still there.
    if (act && !(await tx.eventHumans.getById(input.eventHumanId))) {
      throw fail("EVENT_HUMAN_NOT_FOUND");
    }

    await tx.eventHumans.detach(input.eventHumanId);

    if (act && picks.length > 0) {
      await settlePicksAfterLineupExit(tx, {
        picks,
        act,
        kind: "removed_from_lineup",
        actorHumanId: input.actorHumanId,
        eventId: record.eventId,
        now,
      });
    }
    await tx.audit.log({
      entity: "event_human",
      entityId: input.eventHumanId,
      action: "detached",
      data: {
        eventId: record.eventId,
        humanId: record.humanId,
        externalName: record.externalName,
        role: record.role,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });
  });
}

async function ensureEventExists(
  tx: TxRepos,
  eventId: string,
): Promise<EventRecord> {
  const event = await tx.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}
