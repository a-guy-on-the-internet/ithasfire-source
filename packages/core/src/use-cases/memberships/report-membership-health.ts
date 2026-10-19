import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipHealthCounts } from "@th/ports/repos/memberships";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

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
  MEMBERSHIP_LIVE_STATUSES,
  MEMBERSHIP_PAYMENT_FAILING_STATUSES,
} from "./membership-status";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const reportMembershipHealthInputSchema = z
  .object({
    /**
     * How long an `incomplete` signup may sit before it counts as abandoned.
     *
     * Generous on purpose. `incomplete` is Stripe's state for "the first
     * payment has not succeeded yet", which includes a member who is mid-3DS
     * challenge or who will finish on their phone in an hour. A tight window
     * would page about people who are still in the middle of joining.
     */
    incompleteGraceHours: z.number().int().positive().default(24),
    /**
     * How far ahead to look for scheduled cancellations. Two weeks is roughly
     * the shortest useful notice: it is long enough that an owner can still
     * reach the member, and short enough that the list is a to-do rather than
     * a census of everyone who ever clicked cancel.
     */
    leavingWithinDays: z.number().int().positive().default(14),
    /**
     * How long an UNCHANGED problem picture may stay quiet before it is paged
     * once more. The anti-forgetting backstop, not a repeat alert. At the
     * default the owner hears about a standing problem once a week rather than
     * every day.
     *
     * Longer than moderation's 24h deliberately: this job runs DAILY, so a 24h
     * heartbeat would make the gate a no-op and re-page every single run — the
     * exact behaviour the gate exists to remove.
     */
    reAlertAfterHours: z.number().int().positive().default(168),
  })
  .strict();

export type ReportMembershipHealthInput = z.infer<
  typeof reportMembershipHealthInputSchema
>;

/** Why the caller was (or was not) told to send. Shared gate's vocabulary. */
export const membershipHealthAlertReasons = healthAlertReasons;

export const reportMembershipHealthOutputSchema = z
  .object({
    counts: z.object({
      paymentFailing: z.number().int().nonnegative(),
      stuckIncomplete: z.number().int().nonnegative(),
      leavingSoon: z.number().int().nonnegative(),
    }),
    /**
     * Human-readable problem lines, empty when everything is fine. The CALLER
     * decides what to do with them — this use case holds no alerting
     * transport, so core never learns about Discord.
     */
    problems: z.array(z.string()),
    /** True when `problems` is non-empty. */
    unhealthy: z.boolean(),
    /**
     * Whether the caller should actually PAGE a human this run. Distinct from
     * `unhealthy`: a member whose card has been failing for a month is
     * unhealthy every day and worth paging about only when the picture
     * changes or goes stale.
     */
    shouldAlert: z.boolean(),
    alertReason: z.enum(membershipHealthAlertReasons),
    /** The stable identity of the current problem picture, or null when healthy. */
    fingerprint: z.string().nullable(),
  })
  .strict();

export type ReportMembershipHealthOutput = z.infer<
  typeof reportMembershipHealthOutputSchema
>;

export type ReportMembershipHealthDeps = {
  repos: Pick<Repos, "memberships" | "platformSettings">;
  clock: ClockPort;
  logger: LoggerPort;
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Edge-trigger state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * This gate's own `PlatformSetting` row. One key per health job, never shared:
 * two jobs writing one fingerprint would each suppress the other's incidents.
 */
export const MEMBERSHIP_HEALTH_ALERT_STATE_KEY =
  "memberships:healthAlertState" as const;

const MEMBERSHIP_HEALTH_GATE: HealthAlertGateConfig = {
  settingKey: MEMBERSHIP_HEALTH_ALERT_STATE_KEY,
  logPrefix: "membershipHealth",
  reporterArea: "memberships",
  errorLabel: "membership health",
};

/**
 * THE table of things that can be wrong with the membership book.
 *
 * Typed as a TOTAL `HealthSignalTable` over `MembershipHealthCounts`, so
 * adding a fourth count to the port is a compile error until it is described
 * here. That is the point: the SAME table drives both the operator-facing copy
 * and the fingerprint, so a new signal cannot reach one without the other. A
 * signal wired into `problems` but not into the fingerprint would raise
 * `unhealthy` without moving the string, and during any suppression window it
 * would say nothing at all.
 *
 * Every line NAMES THE CONSEQUENCE, not the state. "12 memberships are
 * past_due" tells an operator nothing they can act on; "12 members are paying
 * for benefits they are currently being denied" does.
 *
 * Declaration order is the order an operator reads the problems in, and the
 * order the fingerprint concatenates — worst first.
 */
const MEMBERSHIP_HEALTH_SIGNALS: HealthSignalTable<
  MembershipHealthCounts,
  ReportMembershipHealthInput
> = {
  paymentFailing: {
    describe: (n) =>
      `${n} membership(s) are past_due or unpaid. Their benefits are ` +
      `ALREADY DENIED at checkout (only active and trialing grant), so each ` +
      `of these members has quietly lost what they signed up for while ` +
      `Stripe retries the card. We send no dunning mail, so nothing else in ` +
      `the system is telling them or their organiser.`,
  },
  stuckIncomplete: {
    describe: (n, input) =>
      `${n} membership signup(s) have sat at 'incomplete' for over ` +
      `${input.incompleteGraceHours}h — the first payment never succeeded. ` +
      `Nobody was charged and nobody is subscribed, so this is a funnel leak ` +
      `rather than a billing failure: one of them per week is noise, a step ` +
      `change means the join flow broke.`,
  },
  leavingSoon: {
    describe: (n, input) =>
      `${n} membership(s) are set to end within ${input.leavingWithinDays} ` +
      `days. This is the last window in which anyone can reach those members ` +
      `— after the period ends the subscription is gone and re-joining is a ` +
      `fresh decision.`,
  },
};

/** The set of signals currently firing, in table order. */
export function fingerprintMembershipHealth(
  counts: MembershipHealthCounts,
): string {
  return fingerprintSignals(MEMBERSHIP_HEALTH_SIGNALS, counts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Daily health read over the membership book.
 *
 * WHY THIS EXISTS. `past_due` was watched by nothing. It is a known constant
 * (`membership-status.ts`) and it DENIES benefits (`resolve-member-benefits`),
 * so a failed card silently stops a member's perks and the first anyone hears
 * about it is a complaint — if the member even connects the two. The only
 * membership job was a tax-rate refresh. Three states that cost real people
 * real things had no operational surface at all.
 *
 * THREE COUNTS, deliberately separate, because they call for different
 * responses:
 *   - `paymentFailing`   → members losing benefits they are paying for. A
 *     support problem, and a refund question if it has run long.
 *   - `stuckIncomplete`  → the join flow leaking. A product problem.
 *   - `leavingSoon`      → a deadline. A retention conversation.
 *
 * Summing them would produce one meaningless number and page for a churn
 * warning as loudly as for a broken checkout.
 *
 * DAILY, NOT HOURLY, and that is a deliberate difference from the moderation
 * health job it shares machinery with. Every signal here is measured in DAYS:
 * Stripe's dunning retries run over roughly two weeks, an abandoned signup is
 * graded against a 24h window, and a cancellation notice is a two-week
 * deadline. An hourly read would re-examine the same rows twenty-four times
 * to learn nothing, and nothing here can degrade fast enough for an hour to
 * matter — unlike a dead moderation drain, which starts holding uploads within
 * minutes.
 *
 * The SEND is edge-triggered on top of that (the gate this shares with
 * moderation), because `paymentFailing` and `leavingSoon` do not return to
 * zero on their own: without the gate one long-failing card would post the
 * identical message every day forever, which is how an alerting channel stops
 * being read.
 *
 * This use case does NOT send anything. It returns `problems` plus a
 * `shouldAlert` verdict, and the job layer obeys it.
 */
export async function reportMembershipHealth(
  deps: ReportMembershipHealthDeps,
  rawInput: unknown = {},
): Promise<ReportMembershipHealthOutput> {
  const { repos, clock } = deps;
  const logger = deps.logger.child({ useCase: "reportMembershipHealth" });
  const input = parseInput(reportMembershipHealthInputSchema, rawInput);

  const now = clock.now();
  const counts = await repos.memberships.countHealth({
    // Imported, never re-listed: these ARE the statuses the benefits resolver
    // refuses to grant on, and a second copy of the list here could drift into
    // paging about a state that still works (or staying quiet about one that
    // does not).
    paymentFailingStatuses: [...MEMBERSHIP_PAYMENT_FAILING_STATUSES],
    liveStatuses: [...MEMBERSHIP_LIVE_STATUSES],
    incompleteBefore: new Date(
      now.getTime() - input.incompleteGraceHours * HOUR_MS,
    ),
    // `now` as the lower bound: a period end already in the past is not a
    // window anyone can act in.
    leavingFrom: now,
    leavingBefore: new Date(now.getTime() + input.leavingWithinDays * DAY_MS),
  });

  // Both the copy and the fingerprint come from MEMBERSHIP_HEALTH_SIGNALS, so
  // a signal can never reach one and miss the other.
  const problems = describeSignals(MEMBERSHIP_HEALTH_SIGNALS, counts, input);
  const unhealthy = problems.length > 0;
  // NULL means healthy, which is how the shared gate is told to clear its row.
  const fingerprint = unhealthy ? fingerprintMembershipHealth(counts) : null;

  const { shouldAlert, alertReason } = await decideHealthAlert(
    deps,
    logger,
    MEMBERSHIP_HEALTH_GATE,
    {
      fingerprint,
      now,
      reAlertAfterMs: input.reAlertAfterHours * HOUR_MS,
    },
  );

  // Log on EVERY unhealthy run, sent or not, so the daily read stays legible
  // in Cloud Logging even while Discord is quiet. Only the page gets rarer.
  if (unhealthy) {
    logger.warn("membershipHealth.unhealthy", {
      ...counts,
      problems,
      shouldAlert,
      alertReason,
      fingerprint,
    });
  }

  return reportMembershipHealthOutputSchema.parse({
    counts,
    problems,
    unhealthy,
    shouldAlert,
    alertReason,
    fingerprint,
  });
}
