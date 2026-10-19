import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { ModerationQueueHealth } from "@th/ports/repos/image-moderation-records";

import { parseInput } from "../../lib/io";
import {
  decideHealthAlert,
  describeSignals,
  fingerprintSignals,
  healthAlertReasons,
  type HealthAlertGateConfig,
  type HealthSignalTable,
} from "../platform/_shared/health-alert-gate";
import {
  deriveQueueHealthCutoffs,
  moderationQueueHealthWindowShape,
} from "./_shared/queue-health-window";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const reportModerationQueueHealthInputSchema = z
  .object({
    // The four window knobs (pendingOverdueMinutes, awaitingReviewHours,
    // degradedWindowMinutes, maxRequeues) and the clock arithmetic that turns
    // them into cutoffs are SHARED with the read-only ops snapshot — see
    // `_shared/queue-health-window.ts`. The /platform page must show the same
    // numbers this job alerts on; two copies of "2 hours" is how it stops.
    ...moderationQueueHealthWindowShape,
    /**
     * How long an UNCHANGED problem picture may stay quiet before it is paged
     * once more. This is the anti-forgetting backstop, not a repeat alert: at
     * the default the owner hears about a standing backlog once a day rather
     * than 24 times a day.
     */
    reAlertAfterHours: z.number().int().positive().default(24),
  })
  .strict();

export type ReportModerationQueueHealthInput = z.infer<
  typeof reportModerationQueueHealthInputSchema
>;

/**
 * Why the caller was (or was not) told to send.
 *
 * Re-exported from the shared gate rather than re-listed: the values ARE the
 * gate's verdicts, and a second copy here could only ever drift out of sync
 * with the thing that produces them.
 */
export const moderationQueueHealthAlertReasons = healthAlertReasons;

export const reportModerationQueueHealthOutputSchema = z
  .object({
    counts: z.object({
      pendingOverdue: z.number().int().nonnegative(),
      awaitingReview: z.number().int().nonnegative(),
      degradedRecent: z.number().int().nonnegative(),
      degradedExhausted: z.number().int().nonnegative(),
      orphanedRecent: z.number().int().nonnegative(),
    }),
    /**
     * Human-readable problem lines, empty when everything is fine. The CALLER
     * decides what to do with them — this use case holds no alerting transport,
     * so core never learns about Discord.
     */
    problems: z.array(z.string()),
    /** True when `problems` is non-empty. Convenience for the job's branch. */
    unhealthy: z.boolean(),
    /**
     * Whether the caller should actually PAGE a human this run. Distinct from
     * `unhealthy`: a standing backlog is unhealthy every hour but worth paging
     * about only when it changes, worsens, or goes stale.
     */
    shouldAlert: z.boolean(),
    /** Why `shouldAlert` came out the way it did. For logs and tests. */
    alertReason: z.enum(moderationQueueHealthAlertReasons),
    /**
     * The stable identity of the current problem picture, or null when
     * healthy. Logged so a human reading the hourly line can see WHY a run
     * was quiet without re-deriving the firing set in their head.
     */
    fingerprint: z.string().nullable(),
  })
  .strict();

export type ReportModerationQueueHealthOutput = z.infer<
  typeof reportModerationQueueHealthOutputSchema
>;

export type ReportModerationQueueHealthDeps = {
  repos: Pick<Repos, "imageModerationRecords" | "platformSettings">;
  clock: ClockPort;
  logger: LoggerPort;
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Edge-trigger state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the last-paged problem picture is remembered. `PlatformSetting` is a
 * plain key/value row — no migration, no new table for one string. An empty
 * value means "no outstanding problem", which is how a healthy run clears it
 * (the repo offers `get`/`upsert` and no delete).
 */
export const MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY =
  "moderation:queueHealthAlertState" as const;

/**
 * Everything this gate needs to own its `PlatformSetting` row and label its
 * own log lines and Sentry reports. The machinery behind it is shared with
 * every other health job (`platform/_shared/health-alert-gate.ts`); the
 * strings are ours.
 */
const MODERATION_HEALTH_GATE: HealthAlertGateConfig = {
  settingKey: MODERATION_QUEUE_HEALTH_ALERT_STATE_KEY,
  logPrefix: "moderationQueueHealth",
  reporterArea: "image-moderation",
  errorLabel: "moderation queue health",
};

/**
 * THE table of things that can be wrong with this queue. One table, on purpose.
 *
 * Typed as a TOTAL `Record` over `ModerationQueueHealth`, so adding a sixth
 * count to the port is a compile error until it is described here. The earlier
 * shape — a hand-written category list `satisfies keyof …[]` — only proved that
 * every listed name was valid, never that every key was listed, and it sat
 * beside a separate stack of `problems.push` calls. That asymmetry was a
 * silence bug waiting to happen: a new signal wired into `problems` but not
 * into the fingerprint would raise `unhealthy` without moving the string, so
 * during any standing suppression window it would say nothing at all. Deriving
 * both the alert copy AND the fingerprint from this one object makes reaching
 * one without the other impossible rather than merely unlikely.
 *
 * Declaration order is the order an operator reads the problems in, and the
 * order the fingerprint concatenates. JS preserves insertion order for
 * non-numeric string keys, so this literal is the ordering — the fingerprint
 * therefore never depends on how a `counts` object happened to be built.
 */
const QUEUE_HEALTH_SIGNALS: HealthSignalTable<
  ModerationQueueHealth,
  ReportModerationQueueHealthInput
> = {
  pendingOverdue: {
    describe: (n, input) =>
      `${n} image(s) have been due for moderation for over ` +
      `${input.pendingOverdueMinutes}m — the drain job may not be running.`,
  },
  degradedRecent: {
    describe: (n, input) =>
      `${n} image(s) failed to scan in the last ` +
      `${input.degradedWindowMinutes}m — the moderation provider is failing.`,
  },
  degradedExhausted: {
    describe: (n) =>
      `${n} image(s) exhausted the requeue cap and can ` +
      `no longer be scanned automatically.`,
  },
  orphanedRecent: {
    describe: (n, input) =>
      `${n} image(s) were resolved as ORPHANED (object ` +
      `missing from storage) in the last ${input.degradedWindowMinutes}m. ` +
      `ORPHANED is terminal and hidden — if this is more than a trickle, ` +
      `check the bucket configuration before the rows pile up.`,
  },
  awaitingReview: {
    describe: (n, input) =>
      `${n} flagged image(s) have been awaiting human ` +
      `review for over ${input.awaitingReviewHours}h. Uploaders are NOT ` +
      `emailed about holds, so nobody else is chasing this.`,
  },
};

/**
 * The set of signals currently firing, in table order.
 *
 * Deliberately NOT the counts — see `fingerprintSignals` for the full reason
 * that magnitude was tried and removed. Kept as a named export because it is
 * this queue's identity function and the gating tests pin its behaviour
 * directly.
 */
export function fingerprintQueueHealth(counts: ModerationQueueHealth): string {
  return fingerprintSignals(QUEUE_HEALTH_SIGNALS, counts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hourly health read over the moderation queue.
 *
 * WHY THIS EXISTS. In August 2026 the Azure subscription lapsed and every image
 * moderation call 401'd for roughly two weeks. Sentry had the errors the whole
 * time and nobody noticed, because an adapter error inside a jobs process reads
 * like noise. The lesson was not "add more error reporting" — it was that the
 * signal operators actually act on is a COUNT that should be zero and isn't.
 *
 * Five counts, deliberately separate, because they call for different
 * responses. Listed in QUEUE_HEALTH_SIGNALS order, which is the order an
 * operator reads the problems in and the order the fingerprint concatenates —
 * this list used to have the last two the other way round, which is a small
 * lie for a reader trying to match a fingerprint string against a description:
 *   - `pendingOverdue`   → the drain is dead. An incident.
 *   - `degradedRecent`   → the provider is failing. Check the vendor.
 *   - `degradedExhausted`→ objects we can never scan. Usually garbage to delete.
 *   - `orphanedRecent`   → objects disappearing from storage. A trickle is
 *     normal; a spike means storage is answering "gone" for things that are
 *     not, and every one of those rows was terminally hidden.
 *   - `awaitingReview`   → real holds nobody has judged. A moderator nudge.
 *
 * Summing them would produce one meaningless number, and alerting on the sum
 * would page for a rotting review queue as loudly as for a dead worker.
 *
 * WHY IT IS EDGE-TRIGGERED. The first cut paged whenever any count was non-zero,
 * which reads as "an alert always means something" and is true exactly once. Two
 * of the five signals never return to zero on their own — `awaitingReview` holds
 * rows until a human judges them, and `degradedExhausted` holds rows that can
 * never be scanned — so a single stuck record produced the same Discord post
 * every hour, forever. That is the identical failure the August outage taught:
 * a channel nobody reads. The read still runs hourly, so a genuinely NEW problem
 * surfaces within the hour; only the SEND is gated, on the problem picture
 * changing, or going `reAlertAfterHours` stale.
 *
 * This use case does NOT send anything. It returns `problems` plus a
 * `shouldAlert` verdict, and the job layer obeys it — keeping the webhook out of
 * core and making both the thresholds and the suppression testable without a
 * transport.
 */
export async function reportModerationQueueHealth(
  deps: ReportModerationQueueHealthDeps,
  rawInput: unknown = {},
): Promise<ReportModerationQueueHealthOutput> {
  const { repos, clock } = deps;
  const logger = deps.logger.child({ useCase: "reportModerationQueueHealth" });
  const input = parseInput(reportModerationQueueHealthInputSchema, rawInput);

  const now = clock.now();
  const counts = await repos.imageModerationRecords.countQueueHealth(
    deriveQueueHealthCutoffs(now, input),
  );

  // Both the copy and the fingerprint come from QUEUE_HEALTH_SIGNALS, so a
  // signal can never reach one and miss the other.
  const problems = describeSignals(QUEUE_HEALTH_SIGNALS, counts, input);

  const unhealthy = problems.length > 0;
  // NULL means healthy, which is how the shared gate is told to clear its row.
  const fingerprint = unhealthy ? fingerprintQueueHealth(counts) : null;

  // The send/suppress decision, the stored `{fingerprint, sentAt}` row and the
  // clear-on-recovery all live in `platform/_shared/health-alert-gate.ts`.
  // Read that file before changing anything about WHEN this pages; read this
  // one for WHAT it pages about.
  const { shouldAlert, alertReason } = await decideHealthAlert(
    deps,
    logger,
    MODERATION_HEALTH_GATE,
    {
      fingerprint,
      now,
      reAlertAfterMs: input.reAlertAfterHours * 3_600_000,
    },
  );

  // Log on EVERY unhealthy run, sent or not, so the hourly read stays legible
  // in Cloud Logging even while Discord is quiet. Only the page gets rarer.
  if (unhealthy) {
    logger.warn("moderationQueueHealth.unhealthy", {
      ...counts,
      problems,
      shouldAlert,
      alertReason,
      fingerprint,
    });
  }

  return reportModerationQueueHealthOutputSchema.parse({
    counts,
    problems,
    unhealthy,
    shouldAlert,
    alertReason,
    fingerprint,
  });
}

