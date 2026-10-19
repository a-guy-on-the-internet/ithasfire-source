import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { CountModerationQueueHealthInput } from "@th/ports/repos/image-moderation-records";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// PER-KIND BREAKDOWN OF THE FIVE QUEUE-HEALTH SIGNALS.
//
// The tiles are global, so `EVENT_HERO` failing to scan while `AVATAR` is fine
// is invisible: one number moves and nothing says which surface broke. That
// distinction is most of the triage — a provider failing on large hero images
// and a provider failing on everything look identical from a single count and
// call for completely different first moves.
//
// TAKES ABSOLUTE CUTOFFS, NOT THE RELATIVE KNOBS — same rule, same reason, as
// `listModerationQueueSignal`. This surface only ever renders UNDER a snapshot,
// so the window is always in hand; re-deriving it from a fresh `clock.now()`
// would let a breakdown total 37 beneath a tile that says 40, with neither
// surface able to say which is right. No clock is read on this path at all,
// which is what makes that impossible rather than merely unlikely.
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationQueueBreakdownDeps = {
  repos: Pick<Repos, "imageModerationRecords">;
};

export const getModerationQueueBreakdownInputSchema = z
  .object({
    /** Echo of `snapshot.cutoffs.pendingDueBefore`. */
    pendingDueBefore: z.coerce.date(),
    /** Echo of `snapshot.cutoffs.moderatedBefore`. */
    moderatedBefore: z.coerce.date(),
    /** Echo of `snapshot.cutoffs.degradedSince`. */
    degradedSince: z.coerce.date(),
    /** Echo of `snapshot.thresholds.maxRequeues`. */
    maxRequeues: z.number().int().positive(),
  })
  .strict();

export type GetModerationQueueBreakdownInput = z.infer<
  typeof getModerationQueueBreakdownInputSchema
>;

const healthCountsSchema = z
  .object({
    pendingOverdue: z.number().int().nonnegative(),
    awaitingReview: z.number().int().nonnegative(),
    degradedRecent: z.number().int().nonnegative(),
    degradedExhausted: z.number().int().nonnegative(),
    orphanedRecent: z.number().int().nonnegative(),
  })
  .strict();

export const getModerationQueueBreakdownOutputSchema = z
  .object({
    /**
     * Dense over all four kinds — a kind with nothing wrong is present with
     * five zeros rather than absent. A UI that has to distinguish "no rows" from
     * "key missing" invents a third state nobody designed.
     */
    byKind: z
      .object({
        EVENT_HERO: healthCountsSchema,
        AVATAR: healthCountsSchema,
        BANNER: healthCountsSchema,
        PAGE_MEDIA: healthCountsSchema,
      })
      .strict(),
    /**
     * Rows whose `kind` is none of the four.
     *
     * `kind` is an app-validated String, not a Prisma enum, so a typo'd or
     * retired value is representable. Surfaced rather than dropped so the
     * columns provably sum to the tiles above them: a breakdown that silently
     * loses rows reads as a counting bug in the dashboard, and the real defect
     * (bad data) never gets looked at.
     *
     * All zeros is the expected state. Anything else is a data-quality finding.
     */
    unrecognizedKinds: healthCountsSchema,
    /**
     * The window this breakdown was computed with, echoed back VERBATIM from
     * the input — not re-derived, because there is nothing to derive. Lets the
     * page assert that the columns belong to the tiles it is showing.
     */
    cutoffs: z
      .object({
        pendingDueBefore: z.date(),
        moderatedBefore: z.date(),
        degradedSince: z.date(),
      })
      .strict(),
    maxRequeues: z.number().int().positive(),
  })
  .strict();

export type GetModerationQueueBreakdownOutput = z.infer<
  typeof getModerationQueueBreakdownOutputSchema
>;

/**
 * The five queue-health counts, split by image kind.
 *
 * Read-only, no clock, `imageModerationRecords` only. The repo derives every
 * bucket from the SAME `queueHealthWhere` predicate the tiles count with, so
 * the columns cannot drift from the number they sit under.
 *
 * Failures propagate. A swallow would show an all-green breakdown during the
 * outage the page exists to surface, and per CLAUDE.md would owe a
 * `reportError` branch; throwing is simpler and more honest.
 */
export async function getModerationQueueBreakdown(
  deps: ModerationQueueBreakdownDeps,
  rawInput: unknown,
): Promise<GetModerationQueueBreakdownOutput> {
  const input = parseInput(getModerationQueueBreakdownInputSchema, rawInput);

  const cutoffs: CountModerationQueueHealthInput = {
    pendingDueBefore: input.pendingDueBefore,
    moderatedBefore: input.moderatedBefore,
    degradedSince: input.degradedSince,
    maxRequeues: input.maxRequeues,
  };

  const breakdown =
    await deps.repos.imageModerationRecords.countQueueHealthByKind(cutoffs);

  return getModerationQueueBreakdownOutputSchema.parse({
    byKind: breakdown.byKind,
    unrecognizedKinds: breakdown.unrecognizedKinds,
    cutoffs: {
      pendingDueBefore: cutoffs.pendingDueBefore,
      moderatedBefore: cutoffs.moderatedBefore,
      degradedSince: cutoffs.degradedSince,
    },
    maxRequeues: cutoffs.maxRequeues,
  });
}
