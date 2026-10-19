import { z } from "zod";

import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// SEVERITY DISTRIBUTION, AGGREGATE ONLY.
//
// The ops page prints "REVIEW THRESHOLD 4" and offers nothing that would tell
// an operator whether 4 is the right number. A threshold is only ever
// defensible against a distribution: if nothing the provider scores ever lands
// on 4 and everything real lands on 6, the threshold is doing no work; if half
// of all uploads land on 4, it is doing far too much and a human is drowning.
//
// WHAT THIS DELIBERATELY IS NOT. No row identity leaves here — no record id, no
// storage key, no subject, no URL, not even a sample. The question is a shape.
// A "show me the 4s" affordance is the drill-down's job, behind the withholding
// rules in `_shared/ops-withholding.ts`, and bolting a preview onto a histogram
// would route around them.
//
// ABSOLUTE INSTANTS, no clock — same convention as the drill-down and the
// breakdown. A page that already holds `snapshot.observedAt` can compute any
// window it wants; a use case that read its own clock would give two surfaces
// two different "now"s for no benefit.
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationSeverityHistogramDeps = {
  repos: Pick<Repos, "imageModerationRecords">;
};

/**
 * Azure Content Safety emits integer severities 0, 2, 4 and 6; the API models
 * the space as 0–6 and other providers may fill the odd values. Densified over
 * the whole range so the chart's x-axis is fixed and a quiet day does not
 * silently rescale it.
 */
export const MODERATION_SEVERITY_SCALE = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * The widest window this will answer for, and why there is a limit at all.
 *
 * `countSeverityHistogram` filters on `moderated_at` with no `status` clause,
 * and no index on `image_moderation_records` carries `moderated_at` as a
 * LEADING column — the two that mention it are `(status, moderated_at)` and a
 * partial requeue index. So this query is a sequential scan, and its cost grows
 * with the whole table rather than with the window.
 *
 * Unbounded, that makes the one page an operator opens DURING an incident also
 * the page that puts the heaviest scan of the day on the database. A "let me
 * see all of it" click at the wrong moment is a self-inflicted load spike on
 * top of whatever is already wrong.
 *
 * 90 days answers every real question here — whether the review threshold sits
 * in the right place, and whether a recent provider or threshold change moved
 * the distribution. Longer-range analysis is a warehouse job, not a dashboard.
 *
 * A CAP RATHER THAN AN INDEX, deliberately: an index would mean a migration,
 * and a migration is not something to fold into a change that otherwise needs
 * none. If the histogram ever wants years, add the index then and raise this
 * with it.
 */
export const MODERATION_SEVERITY_WINDOW_MAX_DAYS = 90;

const MODERATION_SEVERITY_WINDOW_MAX_MS =
  MODERATION_SEVERITY_WINDOW_MAX_DAYS * 24 * 60 * 60 * 1000;

export const getModerationSeverityHistogramInputSchema = z
  .object({
    /** Inclusive lower bound on `moderatedAt`. */
    since: z.coerce.date(),
    /**
     * EXCLUSIVE upper bound on `moderatedAt`. Usually `snapshot.observedAt`.
     * Exclusive so two adjacent windows never count the same scan twice.
     */
    until: z.coerce.date(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // An inverted window is not an empty window — it is a caller bug that
    // would otherwise render as a confident, permanent "0 scans" and be read
    // as "the provider is doing nothing". Refuse it loudly.
    const span = value.until.getTime() - value.since.getTime();
    if (span <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["since"],
        message: "`since` must be strictly before `until`",
      });
      // Return early: a negative span is not also "too wide", and reporting
      // both would send the caller chasing the wrong one.
      return;
    }
    // The scan cap. See MODERATION_SEVERITY_WINDOW_MAX_DAYS — this query is a
    // sequential scan, and an unbounded window turns the incident dashboard
    // into the heaviest query of the incident.
    if (span > MODERATION_SEVERITY_WINDOW_MAX_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["since"],
        message:
          `window must not exceed ${MODERATION_SEVERITY_WINDOW_MAX_DAYS} days`,
      });
    }
  });

export type GetModerationSeverityHistogramInput = z.infer<
  typeof getModerationSeverityHistogramInputSchema
>;

const bucketSchema = z
  .object({
    severity: z.number().int(),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const getModerationSeverityHistogramOutputSchema = z
  .object({
    /**
     * DENSE over 0–6, ascending. Empty buckets are present with `count: 0`.
     */
    buckets: z.array(bucketSchema),
    /**
     * Severities the provider wrote that fall OUTSIDE 0–6.
     *
     * `max_severity` is a plain INTEGER column with no check constraint, so a
     * provider change or a bad mapper can write anything. Folding those into
     * the nearest bucket would quietly corrupt the very distribution this
     * exists to show; dropping them would make `scanned` disagree with the sum
     * of `buckets`. They get their own list, and an empty one is the expected
     * state.
     */
    outOfRange: z.array(bucketSchema),
    /**
     * Total rows scored in the window — the sum of `buckets` + `outOfRange`,
     * by construction. Included so the page never has to decide whether a flat
     * histogram means "nothing scored" or "everything scored 0".
     */
    scanned: z.number().int().nonnegative(),
    /** The window, echoed back verbatim. */
    window: z.object({ since: z.date(), until: z.date() }).strict(),
  })
  .strict();

export type GetModerationSeverityHistogramOutput = z.infer<
  typeof getModerationSeverityHistogramOutputSchema
>;

/**
 * Distribution of provider severities over a window, for judging the review
 * threshold.
 *
 * Counts only rows that were actually SCANNED (`maxSeverity IS NOT NULL`) —
 * PENDING rows have no score yet, orphans never had bytes, and a requeue clears
 * the column, so including them would invent a null bucket and read the
 * distribution low.
 *
 * Read-only, no clock, no row identity. Failures propagate.
 */
export async function getModerationSeverityHistogram(
  deps: ModerationSeverityHistogramDeps,
  rawInput: unknown,
): Promise<GetModerationSeverityHistogramOutput> {
  const input = parseInput(getModerationSeverityHistogramInputSchema, rawInput);

  const rows = await deps.repos.imageModerationRecords.countSeverityHistogram({
    moderatedSince: input.since,
    moderatedBefore: input.until,
  });

  const counts = new Map<number, number>();
  for (const row of rows) {
    // `+=` rather than `set`: the repo groups by severity so duplicates should
    // be impossible, and a silently dropped bucket would be worse than a
    // slightly redundant accumulate.
    counts.set(row.severity, (counts.get(row.severity) ?? 0) + row.count);
  }

  const buckets = MODERATION_SEVERITY_SCALE.map((severity) => ({
    severity,
    count: counts.get(severity) ?? 0,
  }));

  const inScale = new Set<number>(MODERATION_SEVERITY_SCALE);
  const outOfRange = [...counts.entries()]
    .filter(([severity]) => !inScale.has(severity))
    .sort(([a], [b]) => a - b)
    .map(([severity, count]) => ({ severity, count }));

  const scanned =
    buckets.reduce((sum, b) => sum + b.count, 0) +
    outOfRange.reduce((sum, b) => sum + b.count, 0);

  return getModerationSeverityHistogramOutputSchema.parse({
    buckets,
    outOfRange,
    scanned,
    window: { since: input.since, until: input.until },
  });
}
