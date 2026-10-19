import { z } from "zod";

import type { CountModerationQueueHealthInput } from "@th/ports/repos/image-moderation-records";

// ─────────────────────────────────────────────────────────────────────────────
// The window knobs, and the ONE clock arithmetic that turns them into cutoffs.
//
// Two callers need this: the hourly alert job (`report-moderation-queue-health`)
// and the read-only ops snapshot (`get-moderation-queue-snapshot`). They must
// produce IDENTICAL cutoffs from an identical clock, or the /platform page
// shows numbers the Discord alert disagrees with and there is no way to tell
// which one is right. Sharing the shape AND the derivation is what makes that
// impossible rather than merely unlikely.
//
// The repo does no clock arithmetic of its own — it takes four absolute
// instants (see `CountModerationQueueHealthInput`), so this is the only place
// in the system where "2 hours" becomes a `Date`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four window knobs, as a raw zod SHAPE rather than a finished object
 * schema, so a caller can extend it with its own keys and still apply its own
 * `.strict()` (`reportModerationQueueHealth` adds `reAlertAfterHours`).
 */
export const moderationQueueHealthWindowShape = {
  /**
   * A PENDING row still undrained this long after it came due means the drain
   * job itself is not running. Generous relative to the drain's triggers (a
   * wake-up per upload, plus a 30-minute safety-net schedule) so a missed
   * wake-up or a single missed tick is not an incident: 90 minutes is three
   * ticks. It was 60 on the 15-minute schedule, until 2026-10-08.
   */
  pendingOverdueMinutes: z.number().int().positive().default(90),
  /**
   * How long a genuine content hold may sit unreviewed before it counts as
   * rotting. Under the silence-unless-removal policy the uploader is NOT
   * emailed, so this alert is the only thing standing between a held image
   * and an indefinite wait.
   */
  awaitingReviewHours: z.number().int().positive().default(24),
  /** Window for "the scanner is failing right now". */
  degradedWindowMinutes: z.number().int().positive().default(120),
  /** Mirrors the requeue job's cap — rows at/above it are unscannable. */
  maxRequeues: z.number().int().positive().default(3),
} as const;

/** The four knobs on their own, `.strict()`. */
export const moderationQueueHealthWindowSchema = z
  .object(moderationQueueHealthWindowShape)
  .strict();

export type ModerationQueueHealthWindow = z.infer<
  typeof moderationQueueHealthWindowSchema
>;

/**
 * Turn `now` + the knobs into the four absolute instants the repo counts and
 * lists with. Pure — no clock read of its own, so callers stay testable.
 */
export function deriveQueueHealthCutoffs(
  now: Date,
  window: ModerationQueueHealthWindow,
): CountModerationQueueHealthInput {
  return {
    pendingDueBefore: new Date(
      now.getTime() - window.pendingOverdueMinutes * 60_000,
    ),
    moderatedBefore: new Date(
      now.getTime() - window.awaitingReviewHours * 3_600_000,
    ),
    degradedSince: new Date(
      now.getTime() - window.degradedWindowMinutes * 60_000,
    ),
    maxRequeues: window.maxRequeues,
  };
}
