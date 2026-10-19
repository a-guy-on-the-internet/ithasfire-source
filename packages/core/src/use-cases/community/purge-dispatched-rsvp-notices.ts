import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Retention purge for the RSVP-confirmation outbox, mirroring
// purge-dispatched-change-notices (same 30-day window). A dispatched notice
// has served its purpose; the row is just (eventId, humanId) linkage that
// shouldn't accumulate at rest indefinitely.
//
// Only DISPATCHED rows are eligible — undispatched/in-flight notices are
// still owed to recipients and must NEVER be purged. The repo enforces this
// (`dispatchedAt IS NOT NULL AND dispatchedAt < cutoff`).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION_DAYS = 30;

export const purgeDispatchedRsvpNoticesInputSchema = z
  .object({
    /** Days after a notice is DISPATCHED before it is deleted. Defaults to 30. */
    retentionDays: z.number().int().min(1).default(DEFAULT_RETENTION_DAYS),
  })
  .strict();

export const purgeDispatchedRsvpNoticesOutputSchema = z
  .object({
    deleted: z.number().int().nonnegative(),
    cutoff: z.date(),
  })
  .strict();

export type PurgeDispatchedRsvpNoticesInput = z.infer<
  typeof purgeDispatchedRsvpNoticesInputSchema
>;
export type PurgeDispatchedRsvpNoticesOutput = z.infer<
  typeof purgeDispatchedRsvpNoticesOutputSchema
>;

export type PurgeDispatchedRsvpNoticesDeps = {
  repos: Pick<Repos, "rsvpNotices">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function purgeDispatchedRsvpNotices(
  deps: PurgeDispatchedRsvpNoticesDeps,
  rawInput: unknown,
): Promise<PurgeDispatchedRsvpNoticesOutput> {
  const input = parseInput(purgeDispatchedRsvpNoticesInputSchema, rawInput);

  // Cutoff = now minus the retention window. Notices dispatched before this
  // are past their window and eligible for deletion.
  const cutoff = new Date(
    deps.clock.now().getTime() - input.retentionDays * MS_PER_DAY,
  );

  const deleted = await deps.repos.rsvpNotices.deleteDispatchedBefore(cutoff);

  deps.logger?.info("community.purge_dispatched_rsvp_notices", {
    retentionDays: input.retentionDays,
    cutoff,
    deleted,
  });

  return purgeDispatchedRsvpNoticesOutputSchema.parse({ deleted, cutoff });
}
