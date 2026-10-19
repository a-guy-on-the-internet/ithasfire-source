import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/** Days after a form's closesAt before its PENDING submissions expire. */
export const DEFAULT_EXPIRY_GRACE_DAYS = 7;

export const expireEventApplicationsInputSchema = z
  .object({
    /** Override the default grace window for a one-off catch-up run. */
    graceDays: z.coerce
      .number()
      .int()
      .min(0)
      .default(DEFAULT_EXPIRY_GRACE_DAYS),
  })
  .strict();

export const expireEventApplicationsOutputSchema = z
  .object({
    expiredCount: z.number().int().nonnegative(),
  })
  .strict();

export type ExpireEventApplicationsInput = z.infer<
  typeof expireEventApplicationsInputSchema
>;
export type ExpireEventApplicationsOutput = z.infer<
  typeof expireEventApplicationsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ExpireEventApplicationsDeps = {
  repos: Pick<Repos, "tx" | "eventApplications" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scheduled-job entry point (spec Phase 2 item 2, analogue of
 * expire-booking-requests): flip every PENDING application submission whose
 * form closed more than `graceDays` ago to EXPIRED.
 *
 * Boundary: "past closesAt + grace" is STRICT — a submission expires only
 * when `closesAt < now - grace` (the adapter uses `lt`), so a form that
 * closed exactly grace-days ago survives until the next run.
 *
 * One batch repo update (never per-row), one batch audit row, NO emails —
 * expiry is housekeeping, not a decision; the applicant already got the
 * window-closed signal from the gate.
 */
export async function expireEventApplications(
  deps: ExpireEventApplicationsDeps,
  rawInput: unknown = {},
): Promise<ExpireEventApplicationsOutput> {
  const input = parseInput(expireEventApplicationsInputSchema, rawInput);

  const now = deps.clock.now();
  const cutoff = new Date(
    now.getTime() - input.graceDays * 24 * 60 * 60 * 1000,
  );

  const result = await deps.repos.tx(async (tx) => {
    const expired = await tx.eventApplications.expireSubmissionsForClosedForms(
      // ATTEND only: an open call (PERFORM) never auto-closes at its
      // deadline (open calls Q12 / FR-004).
      { cutoff, purpose: "ATTEND" },
    );

    if (expired.count > 0) {
      await tx.audit.log({
        entity: "event",
        entityId: null,
        action: "event_application.expired_batch",
        data: { count: expired.count, ids: expired.ids, cutoff },
        at: now,
      });
    }

    return expired;
  });

  deps.logger?.info("events.applications_expired", {
    expiredCount: result.count,
    cutoff: cutoff.toISOString(),
  });

  return expireEventApplicationsOutputSchema.parse({
    expiredCount: result.count,
  });
}
