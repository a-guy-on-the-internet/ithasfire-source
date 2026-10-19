import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ── Goal ─────────────────────────────────────────────────────────────────────
// Retention purge for the event-change notification outbox. The CANCELLED notice
// payload persists buyer humanIds + refund cents/currency (JSONB); once a notice
// is DISPATCHED it has served its purpose, but the row (and its financial data)
// otherwise lives at rest indefinitely. This bounds that: DELETE dispatched
// notices whose `dispatchedAt` is older than the retention window.
//
// Only DISPATCHED rows are eligible — undispatched/in-flight notices are still
// owed to recipients and must NEVER be purged. The repo enforces this
// (`dispatchedAt IS NOT NULL AND dispatchedAt < cutoff`).

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULT_RETENTION_DAYS = 30;

export const purgeDispatchedChangeNoticesInputSchema = z
  .object({
    /**
     * Days after a notice is DISPATCHED before it (and its persisted buyer /
     * refund payload) is deleted. Defaults to 30.
     */
    retentionDays: z.number().int().min(1).default(DEFAULT_RETENTION_DAYS),
  })
  .strict();

export const purgeDispatchedChangeNoticesOutputSchema = z
  .object({
    deleted: z.number().int().nonnegative(),
    cutoff: z.date(),
  })
  .strict();

export type PurgeDispatchedChangeNoticesInput = z.infer<
  typeof purgeDispatchedChangeNoticesInputSchema
>;
export type PurgeDispatchedChangeNoticesOutput = z.infer<
  typeof purgeDispatchedChangeNoticesOutputSchema
>;

export type PurgeDispatchedChangeNoticesDeps = {
  repos: Pick<Repos, "eventChangeNotices">;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function purgeDispatchedChangeNotices(
  deps: PurgeDispatchedChangeNoticesDeps,
  rawInput: unknown,
): Promise<PurgeDispatchedChangeNoticesOutput> {
  const input = parseInput(purgeDispatchedChangeNoticesInputSchema, rawInput);

  // Cutoff = now minus the retention window. Notices dispatched before this are
  // past their window and eligible for deletion.
  const cutoff = new Date(
    deps.clock.now().getTime() - input.retentionDays * MS_PER_DAY,
  );

  const deleted =
    await deps.repos.eventChangeNotices.deleteDispatchedBefore(cutoff);

  deps.logger?.info("events.purge_dispatched_change_notices", {
    retentionDays: input.retentionDays,
    cutoff,
    deleted,
  });

  return purgeDispatchedChangeNoticesOutputSchema.parse({ deleted, cutoff });
}
