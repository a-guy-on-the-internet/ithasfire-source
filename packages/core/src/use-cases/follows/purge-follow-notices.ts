import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// Retention for the follow-notification outbox. A notice and its deliveries
// only matter until the event starts: after that nothing more is sent
// (`isAnnounceableEvent` refuses a started event). The rows then hold who
// follows whom and which alerts went out, so they are kept for a support and
// debugging window and deleted.
//
// Deletion is keyed on the EVENT's start (or the event being gone), never on
// a delivery's `finishedAt`. Deliveries of a future event must stay until it
// starts: the (eventId, humanId) unique key on them is what stops a second
// followed page's notice from alerting the same person again.
//
// 30 days, the same window as the other notification outboxes
// (`purge-dispatched-change-notices`, `purge-dispatched-rsvp-notices`): long
// enough to answer "why didn't I get an alert" and to look at dead-letters.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const FOLLOW_NOTICE_RETENTION_DAYS = 30;

export const purgeFollowNoticesInputSchema = z
  .object({
    retentionDays: z.number().int().min(1).default(FOLLOW_NOTICE_RETENTION_DAYS),
  })
  .strict();

export const purgeFollowNoticesOutputSchema = z
  .object({ deletedNotices: z.number().int().nonnegative(), cutoff: z.date() })
  .strict();

export type PurgeFollowNoticesDeps = {
  repos: Pick<Repos, "entityEventNotices">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function purgeFollowNotices(deps: PurgeFollowNoticesDeps, rawInput: unknown) {
  const input = parseInput(purgeFollowNoticesInputSchema, rawInput);
  const cutoff = new Date(deps.clock.now().getTime() - input.retentionDays * MS_PER_DAY);
  const { notices } = await deps.repos.entityEventNotices.purgeStartedBefore(cutoff);
  deps.logger?.info("follows.purge_follow_notices", { retentionDays: input.retentionDays, cutoff, deletedNotices: notices });
  return purgeFollowNoticesOutputSchema.parse({ deletedNotices: notices, cutoff });
}
