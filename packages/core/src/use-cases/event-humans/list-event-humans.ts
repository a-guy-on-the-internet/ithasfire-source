import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import { fail } from "@th/errors";

const EVENT_HUMAN_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
  "VENDOR",
  "VOLUNTEER",
  "OTHER",
] as const;

export const listEventHumansInput = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
});

export const listEventHumansOutput = z.array(
  z.object({
    id: z.uuid(),
    eventId: z.uuid(),
    humanId: z.uuid().nullable(),
    externalName: z.string().nullable(),
    externalUrl: z.string().nullable(),
    role: z.enum(EVENT_HUMAN_ROLES),
    customRoleLabel: z.string().nullable(),
    sortOrder: z.number().int(),
    profileSlug: z.string().nullable(),
    humanDisplayName: z.string().nullable(),
  }),
);

export type ListEventHumansInput = z.infer<typeof listEventHumansInput>;
export type ListEventHumansOutput = z.infer<typeof listEventHumansOutput>;

export type ListEventHumansDeps = {
  repos: Repos;
  /**
   * Admits a community moderator to an ownerless listing's lineup — see
   * {@link ensureOwnerOrCommunityModerator}. Required, not optional: an
   * omitted probe would fail closed and leave the builder's lineup panel
   * empty on every community listing with nothing to explain it.
   */
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listEventHumans(
  deps: ListEventHumansDeps,
  rawInput: unknown,
): Promise<ListEventHumansOutput> {
  const input = parseInput(listEventHumansInput, rawInput);

  const event = await ensureEventExists(deps.repos, input.eventId);
  await ensureOwnerOrCommunityModerator(deps, event, input.actorHumanId);

  const records = await deps.repos.eventHumans.listByEvent(input.eventId);

  return listEventHumansOutput.parse(
    records.map((r) => ({
      id: r.id,
      eventId: r.eventId,
      humanId: r.humanId,
      externalName: r.externalName,
      externalUrl: r.externalUrl,
      role: r.role,
      customRoleLabel: r.customRoleLabel,
      sortOrder: r.sortOrder,
      profileSlug: r.profileSlug,
      humanDisplayName: r.humanDisplayName,
    })),
  );
}

async function ensureEventExists(
  repos: Repos,
  eventId: string,
): Promise<EventRecord> {
  const event = await repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}
