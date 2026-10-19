import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import { fail } from "@th/errors";

export const reorderEventHumansInput = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
  orderedIds: z.array(z.uuid()).min(1),
});

export type ReorderEventHumansInput = z.infer<typeof reorderEventHumansInput>;

export type ReorderEventHumansDeps = {
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

export async function reorderEventHumans(
  deps: ReorderEventHumansDeps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(reorderEventHumansInput, rawInput);

  await deps.repos.tx(async (tx) => {
    const event = await ensureEventExists(tx, input.eventId);
    await ensureOwnerOrCommunityModerator(
      { repos: tx, authz: deps.authz },
      event,
      input.actorHumanId,
    );

    await tx.eventHumans.reorder(input.eventId, input.orderedIds);

    const now = deps.clock.now();
    await tx.audit.log({
      entity: "event",
      entityId: input.eventId,
      action: "event_humans_reordered",
      data: {
        orderedIds: input.orderedIds,
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
