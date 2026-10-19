import { z } from "zod";

import { parseInput } from "../../lib/io";

/**
 * Rolling reserve on MEMBERSHIP payout revenue (spec 2026-08-05
 * recurring-memberships, "Dispute policy"):
 *
 *   "hold a small percentage of membership revenue for 90 days, released if
 *    no dispute lands. A reserve is deferred payout, not revenue… It must
 *    apply to NEW and unproven payees from day one and season down with
 *    history."
 *
 * This module is the PURE curve: given an owner's standing, dispute history
 * and payout track record, decide what fraction of the payout's membership
 * portion to defer and for how long. All I/O (gathering those inputs, the
 * withholding itself, the ledger entries) lives in run-batch.ts.
 *
 * The reserve exists for exactly one abuse shape — self-dealing cash-out
 * (subscribe stolen cards to your own tier, collect the payout before the
 * chargebacks land). Every bracket below is sized against that: the risk
 * peaks when a payee has NO history, which is precisely when dispute-count
 * triggers are blind.
 */

// ── Tunables ─────────────────────────────────────────────────────────────────
// One place, deliberately. These are policy knobs, not physics: expect them to
// be re-tuned as real dispute data accumulates. A platform admin can always
// pin an individual owner via the standing override (overriddenBy != null),
// which beats everything here.
export const MEMBERSHIP_RESERVE_TUNING = {
  /** Reserve on a payee's first 90 days of membership payouts. 1000 = 10%. */
  NEW_PAYEE_RESERVE_BPS: 1000,
  /**
   * A payee with ESTABLISHED ticketing history (first transferred ticketing
   * payout more than TICKETING_HISTORY_MIN_DAYS ago) starts here instead of
   * NEW_PAYEE_RESERVE_BPS: they have already passed Stripe KYC AND run real
   * money through us without incident, so the day-one risk premium halves.
   */
  ESTABLISHED_TICKETING_STARTER_BPS: 500,
  /** Reserve during the 90–180 day seasoning window. */
  SEASONING_RESERVE_BPS: 500,
  /** Reserve once seasoned (first membership payout > 180 days ago). */
  SEASONED_RESERVE_BPS: 0,
  /** Reserve while a LOST membership dispute is recent. Back to unproven. */
  LOST_DISPUTE_RESERVE_BPS: 1000,
  /**
   * How long a LOST membership dispute keeps the owner at
   * LOST_DISPUTE_RESERVE_BPS — and (see isReserveReleaseFrozen) how long it
   * freezes the release of already-held reserve.
   */
  LOST_DISPUTE_WINDOW_DAYS: 180,
  /** First-membership-payout age at which seasoning begins. */
  SEASONING_STARTS_AT_DAYS: 90,
  /** First-membership-payout age past which the reserve drops to 0. */
  SEASONED_AFTER_DAYS: 180,
  /** Ticketing payout history must be at least this old to count. */
  TICKETING_HISTORY_MIN_DAYS: 90,
  /** Days a reserved slice is held before release (unless overridden). */
  DEFAULT_RELEASE_DAYS: 90,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why the curve returned what it did. Stamped into the payout audit log so a
 * withheld payout can always be explained on a payee's statement.
 */
export type MembershipReserveBasis =
  /** Platform admin pinned the standing (`overriddenBy != null`). Always wins. */
  | "manual"
  /** LOST membership dispute within LOST_DISPUTE_WINDOW_DAYS. */
  | "lost_dispute"
  /** First 90 days of membership payouts (or the very first one, right now). */
  | "new"
  /** 90–180 days of membership payout history. */
  | "seasoning"
  /** More than 180 days of clean membership payout history. */
  | "seasoned";

export const membershipReserveInputSchema = z
  .object({
    /** Batch time. All ages are measured against this. */
    now: z.date(),
    /**
     * The owner's MembershipStanding, if any. `overriddenBy != null` means a
     * platform admin pinned the values — used VERBATIM, seasoning never
     * recomputes a pinned row (see MembershipStandingRecord). A standing row
     * with `overriddenBy == null` (e.g. written by a future automated pass)
     * does NOT pin anything and the curve is computed normally.
     */
    standing: z
      .object({
        reserveBps: z.number().int().min(0).max(10_000),
        reserveReleaseDays: z.number().int().min(0).max(365),
        overriddenBy: z.string().nullable(),
      })
      .nullable(),
    /**
     * When the owner's most recent LOST membership dispute closed (best
     * available timestamp — see latestLostMembershipDisputeAtByOwner for the
     * closedAt/createdAt approximation). Null = never lost one.
     */
    latestLostDisputeAt: z.date().nullable(),
    /**
     * When the payee's first payout CONTAINING ANY membership line
     * transferred — which is what `earliestTransferredPayoutAtByPayee`
     * actually measures: a mostly-ticketing payout with a single membership
     * line counts, so this can predate the first payout that was
     * meaningfully "a membership payout". Null = no such payout yet (the
     * maximum-risk case). Error direction of the approximation: the
     * seasoning clock starts at the earliest defensible moment, i.e. toward
     * LESS reserve later — accepted and deliberate, not accidental.
     */
    firstMembershipPayoutAt: z.date().nullable(),
    /**
     * When the payee's FIRST ticketing payout transferred. Null = none.
     * Only consulted for the first-bracket head start.
     */
    firstTicketingPayoutAt: z.date().nullable(),
  })
  .strict();

export type MembershipReserveInput = z.infer<
  typeof membershipReserveInputSchema
>;

export interface MembershipReserveDecision {
  /** Basis points of the payout's MEMBERSHIP portion to defer. */
  reserveBps: number;
  /** Days the deferred slice is held before release. */
  releaseDays: number;
  /** Which rule produced the numbers. Audit-stamped by the caller. */
  basis: MembershipReserveBasis;
}

function fullDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

/**
 * The seasoning curve. Pure and total — no I/O, no clock reads, no floats on
 * money (bps are applied by the caller with integer floor division).
 *
 * Precedence, top wins:
 *  1. Manual standing override (`overriddenBy != null`) — verbatim, always.
 *  2. LOST membership dispute within the last 180 days → 1000 bps.
 *  3. Membership payout track record:
 *       first payout age  < 90 days (or none yet) → 1000 bps ("new")
 *                          — halved to 500 when the payee has ticketing
 *                            payout history older than 90 days,
 *       90–180 days (inclusive)                   → 500 bps ("seasoning"),
 *       > 180 days                                → 0 bps  ("seasoned").
 *
 * Boundary convention: brackets follow the spec text — "age < 90", "90–180"
 * and "> 180" — so day 90 and day 180 both land in the 500 bps bracket.
 */
export function computeMembershipReserve(
  rawInput: unknown,
): MembershipReserveDecision {
  const input = parseInput(membershipReserveInputSchema, rawInput);
  const T = MEMBERSHIP_RESERVE_TUNING;

  if (input.standing && input.standing.overriddenBy != null) {
    return {
      reserveBps: input.standing.reserveBps,
      releaseDays: input.standing.reserveReleaseDays,
      basis: "manual",
    };
  }

  if (
    input.latestLostDisputeAt !== null &&
    fullDaysBetween(input.latestLostDisputeAt, input.now) <=
      T.LOST_DISPUTE_WINDOW_DAYS
  ) {
    return {
      reserveBps: T.LOST_DISPUTE_RESERVE_BPS,
      releaseDays: T.DEFAULT_RELEASE_DAYS,
      basis: "lost_dispute",
    };
  }

  const membershipAgeDays =
    input.firstMembershipPayoutAt === null
      ? 0
      : fullDaysBetween(input.firstMembershipPayoutAt, input.now);

  if (
    input.firstMembershipPayoutAt === null ||
    membershipAgeDays < T.SEASONING_STARTS_AT_DAYS
  ) {
    const hasEstablishedTicketing =
      input.firstTicketingPayoutAt !== null &&
      fullDaysBetween(input.firstTicketingPayoutAt, input.now) >=
        T.TICKETING_HISTORY_MIN_DAYS;
    return {
      reserveBps: hasEstablishedTicketing
        ? T.ESTABLISHED_TICKETING_STARTER_BPS
        : T.NEW_PAYEE_RESERVE_BPS,
      releaseDays: T.DEFAULT_RELEASE_DAYS,
      basis: "new",
    };
  }

  if (membershipAgeDays <= T.SEASONED_AFTER_DAYS) {
    return {
      reserveBps: T.SEASONING_RESERVE_BPS,
      releaseDays: T.DEFAULT_RELEASE_DAYS,
      basis: "seasoning",
    };
  }

  return {
    reserveBps: T.SEASONED_RESERVE_BPS,
    releaseDays: T.DEFAULT_RELEASE_DAYS,
    basis: "seasoned",
  };
}

/**
 * Is the RELEASE of already-held reserve frozen for this owner?
 *
 * The rule, deliberately owner-level and simple: while the owner's most
 * recent LOST membership dispute is within LOST_DISPUTE_WINDOW_DAYS, NO
 * reserve holds release — matured or not, created before or after the
 * dispute. They re-mature automatically once the window clears (i.e. exactly
 * when the seasoning curve would drop the owner back below
 * LOST_DISPUTE_RESERVE_BPS). This is intentionally more conservative than
 * the per-hold "no lost dispute since this hold was created" reading: it
 * also defers holds created after the dispute, at the cost of releasing them
 * a little later — money delayed, never lost. It applies even when the
 * standing is manually overridden (the override pins the RATE, not the
 * dispute freeze); an admin who needs to force a release can zero the
 * reserve via the override and let the next payout carry the release once
 * the window clears, or use the ops path.
 */
export function isReserveReleaseFrozen(
  latestLostDisputeAt: Date | null,
  now: Date,
): boolean {
  return (
    latestLostDisputeAt !== null &&
    fullDaysBetween(latestLostDisputeAt, now) <=
      MEMBERSHIP_RESERVE_TUNING.LOST_DISPUTE_WINDOW_DAYS
  );
}

/**
 * Integer withholding: floor of the membership portion at `reserveBps`,
 * clamped to the headroom left by higher-priority deductions (debt recovery
 * runs first). Floor, not round: when in doubt we defer one cent LESS, the
 * payee-favouring direction, and the amount stays exactly reproducible.
 */
export function computeReserveHoldCents(args: {
  membershipPortionCents: number;
  reserveBps: number;
  headroomCents: number;
}): number {
  if (args.membershipPortionCents <= 0 || args.reserveBps <= 0) return 0;
  const raw = Math.floor((args.membershipPortionCents * args.reserveBps) / 10_000);
  return Math.max(0, Math.min(raw, args.headroomCents));
}
