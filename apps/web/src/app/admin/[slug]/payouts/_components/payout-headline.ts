import type { GetOrgPayoutOverviewOutput } from "@th/core/use-cases/payouts/get-org-payout-overview";
import type { GetPayeeStatementOutput } from "@th/core/use-cases/payouts/get-payee-statement";

import { fmtCalendarDateShort, type CalendarDateFmt } from "@/lib/format";

// ─────────────────────────────────────────────────────────────────────────────
// The headline both owners share. An org gets it from `payouts.getOverview`;
// a human owner (whose payee has no per-event overview) gets it from the
// statement's own headline fields. Neither source is ever summed with the
// other, and nothing here re-derives a verdict the backend already made —
// `belowMinimum` and `payoutOverdue` arrive as the server computed them, null
// and all, and the view only decides which SENTENCE each null gets.
// ─────────────────────────────────────────────────────────────────────────────

export type PayoutHeadline = {
  payeeId: string | null;
  currency: string;
  /** Everything owed, matured or not. Always known. */
  balanceCents: number;
  /** Null iff `payableResolved` is false. Signed: negative is carried debt. */
  payableCents: number | null;
  payableResolved: boolean;
  /** Cents held against open disputes — owed to someone, not yet to anyone. */
  pendingHoldCents: number;
  /** Rolling reserve withheld from past transfers. Never inside the balance. */
  reserveCents: number;
  /** Null iff `minimumResolved` is false. */
  payoutMinimumCents: number | null;
  minimumResolved: boolean;
  /** The server's verdict. Null = cannot say (or nothing to measure). */
  belowMinimum: boolean | null;
  /** The server's verdict. Null = cannot say. Only `true` is an incident. */
  payoutOverdue: boolean | null;
  /**
   * The Central calendar date (YYYY-MM-DD) of the evening the next payout
   * batch closes — "tonight's run". Null when the server did not say.
   */
  nextPayoutRunNight: string | null;
};

export function headlineFromOverview(
  overview: GetOrgPayoutOverviewOutput,
): PayoutHeadline {
  return {
    payeeId: overview.payeeId,
    currency: overview.currency,
    balanceCents: overview.balanceCents,
    payableCents: overview.payableCents,
    payableResolved: overview.payableResolved,
    pendingHoldCents: overview.pendingHoldCents,
    reserveCents: overview.reserveCents,
    payoutMinimumCents: overview.payoutMinimumCents,
    minimumResolved: overview.minimumResolved,
    belowMinimum: overview.belowMinimum,
    payoutOverdue: overview.payoutOverdue,
    // Optional-chained on purpose: during a rolling deploy a newer web can
    // meet an older API that does not send the field yet, and the caption
    // then falls back to the dateless copy instead of crashing the page.
    nextPayoutRunNight: overview.nextPayoutRun?.night ?? null,
  };
}

/**
 * The statement throws rather than degrading its payable read, so a statement
 * in hand means `payableResolved` is true by construction. It carries no
 * overdue verdict, and "no verdict" is null — never false.
 */
export function headlineFromStatement(
  statement: GetPayeeStatementOutput,
): PayoutHeadline {
  return {
    payeeId: statement.payeeId,
    currency: statement.currency,
    balanceCents: statement.balanceCents,
    payableCents: statement.payableCents,
    payableResolved: true,
    pendingHoldCents: statement.pendingHoldCents,
    reserveCents: statement.reserveCents,
    payoutMinimumCents: statement.payoutMinimumCents,
    minimumResolved: statement.minimumResolved,
    belowMinimum: statement.belowMinimum,
    payoutOverdue: null,
    // Same deploy-skew guard as `headlineFromOverview`.
    nextPayoutRunNight: statement.nextPayoutRun?.night ?? null,
  };
}

/**
 * Which of the minimum row's states to render. The ORDER is the whole
 * function — it mirrors the discriminator the use case documents on
 * `belowMinimum`: check the payee first, then the two reads, and only then
 * the boolean. A null reached any other way would put "couldn't check" in
 * front of every org that has never onboarded.
 */
export type MinimumVerdict =
  | { kind: "no-payee" }
  | { kind: "payable-unresolved" }
  | { kind: "minimum-unresolved" }
  | { kind: "below"; payableCents: number; payoutMinimumCents: number }
  | { kind: "clear"; payableCents: number; payoutMinimumCents: number }
  /**
   * Both reads resolved, a payee exists, yet no verdict. UNREACHABLE by
   * construction today: `_shared/payout-minimum.ts#belowPayoutMinimum`
   * returns a boolean whenever both its inputs are non-null, which the two
   * branches above guarantee. Kept as a typed branch so a future server
   * change that widens the null cannot render a blank as "clear".
   */
  | { kind: "unknown" };

export function minimumVerdict(headline: PayoutHeadline): MinimumVerdict {
  if (headline.payeeId === null) return { kind: "no-payee" };
  if (!headline.payableResolved || headline.payableCents === null) {
    return { kind: "payable-unresolved" };
  }
  if (!headline.minimumResolved || headline.payoutMinimumCents === null) {
    return { kind: "minimum-unresolved" };
  }
  if (headline.belowMinimum === true) {
    return {
      kind: "below",
      payableCents: headline.payableCents,
      payoutMinimumCents: headline.payoutMinimumCents,
    };
  }
  if (headline.belowMinimum === false) {
    return {
      kind: "clear",
      payableCents: headline.payableCents,
      payoutMinimumCents: headline.payoutMinimumCents,
    };
  }
  return { kind: "unknown" };
}

/**
 * What the next nightly run sends, or null when that cannot be said. Zero is
 * only ever returned for a MEASURED "under the minimum" — a missing number is
 * never a zero. NOT A PROMISE: the payee cap, eligibility checks and
 * transfer-time withholding are unmodelled here, and the copy beside this
 * figure says so.
 */
export function tonightSendsCents(verdict: MinimumVerdict): number | null {
  switch (verdict.kind) {
    case "clear":
      return verdict.payableCents;
    case "below":
      return 0;
    default:
      return null;
  }
}

/**
 * Meter fill as a 0–1 fraction. Purely visual — the VERDICT comes from the
 * server; this only decides how much of the track to paint.
 */
export function minimumMeterFraction(verdict: MinimumVerdict): number {
  if (verdict.kind !== "below" && verdict.kind !== "clear") return 0;
  if (verdict.payoutMinimumCents <= 0) return verdict.payableCents > 0 ? 1 : 0;
  const ratio = verdict.payableCents / verdict.payoutMinimumCents;
  return Math.min(1, Math.max(0, ratio));
}

// ── The "We send it" caption ────────────────────────────────────────────────

/**
 * Formats the batch night (a CALENDAR date, YYYY-MM-DD) as a short date, or
 * null when it is malformed. See `fmtCalendarDateShort`: the string names a
 * day, not an instant, so the viewer's zone cannot move it.
 */
export function formatPayoutNight(
  fmt: CalendarDateFmt,
  night: string,
): string | null {
  return fmtCalendarDateShort(fmt, night);
}

/**
 * Whether the batch will skip this payee, from the loaded Stripe status. The
 * batch (`payeePayoutBlocker`) checks only that a Stripe account exists and
 * `payoutsEnabled`; charges do not enter into it. A loading or failed read
 * (`undefined`) is never a blocker.
 */
export function payoutsBlockedFromStatus(
  status: { connected: boolean; payoutsEnabled: boolean } | undefined,
): boolean {
  if (status === undefined) return false;
  return !(status.connected && status.payoutsEnabled);
}

/**
 * Whether "Ready now" earns its own figure beside the answer. It equals what
 * we send in exactly one state: the payable is measured, it clears the
 * minimum, and Stripe can receive it. Everywhere else the two differ (under
 * the minimum the send is a measured zero; blocked, the send is zero while
 * the money waits; unread, the send is unknown) and the page shows both.
 * Holds and fees never enter: holds are already outside the payable, and
 * fees are outside both figures ("before any holds or fees").
 */
export function readyNowDiffers(
  verdict: MinimumVerdict,
  payoutsBlocked: boolean,
): boolean {
  return payoutsBlocked || verdict.kind !== "clear";
}

/** The lead sentence of the answer, as data the view words. */
export type AnswerLead =
  /** A measured send. Zero only under the minimum. */
  | { kind: "sends"; cents: number }
  /** Stripe cannot receive payouts: nothing goes, `readyCents` waits. */
  | { kind: "on-hold"; readyCents: number | null }
  /** The send cannot be measured (a read failed). */
  | { kind: "unknown" };

export function answerLead(
  headline: PayoutHeadline,
  payoutsBlocked: boolean,
): AnswerLead {
  if (payoutsBlocked) {
    const ready =
      headline.payableResolved &&
      headline.payableCents !== null &&
      headline.payableCents > 0
        ? headline.payableCents
        : null;
    return { kind: "on-hold", readyCents: ready };
  }
  const cents = tonightSendsCents(minimumVerdict(headline));
  return cents === null ? { kind: "unknown" } : { kind: "sends", cents };
}

/** What the overview says about money still maturing. */
export type ComingLaterInput = Pick<
  GetOrgPayoutOverviewOutput,
  | "upcoming"
  | "upcomingTruncated"
  | "upcomingResolved"
  | "upcomingExpectedCents"
>;

/**
 * "…$X more ready by <date>." — the money still maturing after tonight, and the
 * date the last of it matures. Built only from the overview:
 *
 * - the amount is `upcomingExpectedCents`, the server's sum over EVERY
 *   upcoming tranche (cap ignored) net of carried debt. Never the gross: a
 *   refund owed from an earlier event would make the gross overstate it.
 *   Null (the maturity or payable read failed) or nothing positive → no
 *   clause at all.
 * - the date is the last tranche's `maturesAt`, and only when the list is
 *   complete. A truncated list's last row is not the last date, so the
 *   clause then names the amount and no date.
 *
 * Maturity is not a promise to pay (the server contract says `expectedCents`
 * IS NOT A PROMISE: the minimum, the payee cap and Stripe still apply on the
 * night), so the copy says "ready by" / "maturing", never "sent" or "paid".
 */
export function comingLater(
  input: ComingLaterInput,
): { cents: number; by: Date | null } | null {
  if (!input.upcomingResolved) return null;
  const cents = input.upcomingExpectedCents;
  if (cents === null || cents <= 0) return null;
  const last = input.upcoming[input.upcoming.length - 1];
  const by = !input.upcomingTruncated && last ? last.maturesAt : null;
  return { cents, by };
}

type CaptionTranslate = (key: string, values?: { date: string }) => unknown;

/**
 * The "We send it" sub-line. Names the date of the next batch run when it is
 * known and falls back to the dateless "next nightly run" copy when not; the
 * below-minimum reason or the can't-say note appends to either, exactly as
 * before. Every variant keeps the "before any holds or fees" caveat — the
 * figure forecasts the batch's INPUT, not what lands.
 */
export function sendCaption(
  t: CaptionTranslate,
  verdict: MinimumVerdict,
  nightLabel: string | null,
  /**
   * True only when the Stripe status is LOADED and says payouts are not
   * enabled: the batch skips the payee, so no date is promised. An unknown
   * (loading, failed) status is never a blocker.
   */
  payoutsBlocked = false,
): string {
  // Blocked is the whole caption: a date, a minimum reason or a "can't say"
  // would each promise or explain a send that will not happen.
  if (payoutsBlocked) return String(t("admin.payoutsSendSubBlocked"));
  const base =
    nightLabel !== null
      ? String(t("admin.payoutsSendSubNight", { date: nightLabel }))
      : String(t("admin.payoutsSendSub"));
  if (verdict.kind === "below") {
    return `${base} · ${String(t("admin.payoutsSendBelowReason"))}`;
  }
  if (tonightSendsCents(verdict) === null) {
    return `${base} · ${String(t("admin.payoutsCantSay"))}`;
  }
  return base;
}
