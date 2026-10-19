// ─────────────────────────────────────────────────────────────────────────────
// Shared bits for the three VISIBILITY sections on /platform/memberships
// ("Recurring revenue", "Needs attention", "Leaving"). The RISK half of the
// page — suspension and rolling reserve — lives in MembershipStandingsView and
// does not share these.
// ─────────────────────────────────────────────────────────────────────────────

/** Owner XOR, as the read model resolves it. */
export type MembershipOwnerRef = {
  ownerType: "ORG" | "HUMAN";
  ownerId: string;
  ownerLabel: string | null;
  /** Organisation slug for the `/admin/<slug>` link; null for people. */
  ownerSlug: string | null;
};

/**
 * Where "Goes to" links.
 *
 * Organisations have an admin surface at `/admin/<slug>`; people have none, so
 * the link is the platform humans list pre-filtered by name — the same target
 * the settlements sections use. Null = render as plain text.
 */
export function membershipOwnerHref(row: MembershipOwnerRef): string | null {
  if (row.ownerType === "ORG") {
    return row.ownerSlug ? `/admin/${encodeURIComponent(row.ownerSlug)}` : null;
  }
  const name = row.ownerLabel?.trim();
  return name ? `/platform/humans?q=${encodeURIComponent(name)}` : null;
}

/** Never blank. Falls back to the id so a degraded row is still actionable. */
export function membershipOwnerName(row: MembershipOwnerRef): string {
  return row.ownerLabel?.trim() || row.ownerId;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * A DURATION, localised: "9 days", "5 hours", "2 months".
 *
 * Deliberately NOT `Intl.RelativeTimeFormat`, which produces "9 days ago" /
 * "in 9 days". Both sentences this feeds already supply their own direction —
 * "Card failing for 9 days", "Ends in 9 days" — so a formatter that adds one
 * would double it.
 *
 * MEASURED AGAINST THE SERVER'S `asOf`, never `Date.now()`. Two reasons: the
 * server clock is the one the row was selected against (a row is in the
 * "leaving" bucket because the SERVER said its period end is inside the
 * window), and a browser clock that disagrees would render a countdown that
 * contradicts the membership of the list it appears in.
 *
 * Buckets are coarse on purpose. "Failing for 9 days" is the actionable fact;
 * "failing for 9 days, 4 hours and 12 minutes" is the same fact plus noise, on
 * a number that is approximate to begin with (see `sinceBasis`).
 */
export function formatDurationBetween(
  from: Date,
  to: Date,
  locale: string,
): string {
  const ms = Math.abs(to.getTime() - from.getTime());
  const unit = (value: number, u: "minute" | "hour" | "day" | "month" | "year") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: u,
      unitDisplay: "long",
      maximumFractionDigits: 0,
    }).format(value);

  if (ms < HOUR_MS) return unit(Math.max(1, Math.floor(ms / MINUTE_MS)), "minute");
  if (ms < DAY_MS) return unit(Math.floor(ms / HOUR_MS), "hour");
  const days = Math.floor(ms / DAY_MS);
  if (days < 60) return unit(Math.max(1, days), "day");
  if (days < 365) return unit(Math.floor(days / 30), "month");
  return unit(Math.floor(days / 365), "year");
}

/**
 * The labels for the three states the "Needs attention" bucket can hold.
 *
 * `past_due` and `unpaid` are NOT the same fact and must not share a label:
 * `past_due` is Stripe still retrying (the card may yet work), `unpaid` is
 * Stripe having exhausted its retries (it will not). Somebody triaging the
 * list acts differently on each.
 *
 * THE THIRD COPY of these strings, and the only one that is presentational.
 * The source of truth is `MEMBERSHIP_PAYMENT_FAILING_STATUSES` in
 * `packages/core/src/use-cases/memberships/membership-status.ts` (with
 * `incomplete` added by `listMembershipPositions`'s attention bucket); a
 * drift test there pins it against `MEMBERSHIP_LIVE_STATUSES` and
 * `MEMBERSHIP_BENEFIT_GRANTING_STATUSES`. This map cannot import it — web
 * components do not reach into core use cases — so it mirrors rather than
 * derives, and the fallback below is what makes the mirror safe.
 *
 * A status outside the three is possible in principle — `Membership.status`
 * mirrors Stripe's vocabulary verbatim and Stripe has added values before — so
 * the caller falls back to rendering the raw string rather than a wrong label.
 * That fallback is the whole reason a drifted copy degrades to "shows an
 * unfamiliar word" instead of "asserts the wrong cause".
 */
export const ATTENTION_STATUS_LABEL_KEY: Record<string, string> = {
  past_due: "platformMemberships.mvStatusPastDue",
  unpaid: "platformMemberships.mvStatusUnpaid",
  incomplete: "platformMemberships.mvStatusIncomplete",
};

/** True for the statuses where the member is currently denied every benefit. */
export function benefitsDenied(status: string): boolean {
  return status === "past_due" || status === "unpaid";
}
