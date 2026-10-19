import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// summariseRecurringRevenue — the staff "what is memberships actually worth"
// read model, for /platform/memberships.
//
// THIS IS NOT PLATFORM INCOME, AND THE LABEL IS THE FEATURE. Memberships carry
// a 0% platform fee on purpose — a values position, not a pricing tier (see
// the money model at the top of `membership.prisma`). Every cent counted here
// flows to a VENUE or an ARTIST. A number that looked like ours and was not
// would be materially worse than no number at all: it would show up in a
// revenue conversation, get compared against ticketing, and be wrong by 100%.
// The output field is `ownerRevenue*` and the UI copy says so.
//
// ACTIVE AND TRIALING ARE SEPARATE AND ONLY ONE OF THEM IS MONEY. A trialing
// member is entitled to benefits (`MEMBERSHIP_BENEFIT_GRANTING_STATUSES`
// includes them) and has paid nothing. Folding the two into a single
// "subscribers" count would overstate the running rate by exactly the trial
// cohort, so they are counted apart and only `active` feeds the money.
//
// THE ANNUAL NORMALISATION RULE, stated once:
//
//   1. Every ACTIVE membership contributes `tierPriceCents × 12` if its tier
//      bills MONTHly, or `tierPriceCents × 1` if it bills YEARly. That is the
//      ANNUALISED total, and it is exact — pure integer multiplication, no
//      division anywhere near a per-row value.
//   2. The per-currency annualised total is divided by 12 ONCE, with
//      `Math.floor`, to give the monthly figure.
//   3. The 0–11 cent remainder is returned as its own field
//      (`monthlyRemainderCents`) rather than dropped.
//
// Dividing ONCE at the end, not per membership, is the load-bearing half.
// Normalising each annual row on its own would discard up to 11 cents PER
// MEMBER — a hundred annual members at $120.05/yr would lose $5.00 — whereas
// dividing the currency total loses at most 11 cents in total, ever. Floor
// rather than round so the reported monthly figure is never larger than the
// money that actually exists; the remainder field is what stops that
// understatement from being silent.
//
// Currencies never mix. One row per currency, no cross-rate anything.
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the settlements
// views, enforced HERE; the transport checks only that an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

export const RECURRING_REVENUE_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Budget for the grouped subscriber count. Past this the adapter surfaces
 * SERVICE_UNAVAILABLE and the UI renders an inline "timed out — try again"
 * instead of hanging the page. Same 8s as the settlements panels.
 */
export const RECURRING_REVENUE_STATEMENT_TIMEOUT_MS = 8_000;

/** Counted as money. Exactly one status, see the file header. */
const REVENUE_STATUS_ACTIVE = "active";
/** Counted, never valued. */
const REVENUE_STATUS_TRIALING = "trialing";

export type SummariseRecurringRevenueDeps = {
  repos: Pick<Repos, "memberships" | "membershipTiers">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
  /** Reports the best-effort tier lookup failure. */
  reportError?: ReporterPort;
};

export const summariseRecurringRevenueInputSchema = z
  .object({ actorHumanId: z.string().min(1) })
  .strict();

export type SummariseRecurringRevenueInput = z.infer<
  typeof summariseRecurringRevenueInputSchema
>;

export const recurringRevenueCurrencyTotalSchema = z
  .object({
    currency: z.string(),
    /** Memberships in `active` — the ones actually paying. */
    activeCount: z.number().int().nonnegative(),
    /** Memberships in `trialing` — entitled, paying nothing yet. */
    trialingCount: z.number().int().nonnegative(),
    /**
     * Σ over ACTIVE memberships of `priceCents × (interval === YEAR ? 1 : 12)`.
     * Exact integer arithmetic; no division has touched it.
     */
    annualisedCents: z.number().int().nonnegative(),
    /**
     * `floor(annualisedCents / 12)`. Never larger than the money that exists —
     * see `monthlyRemainderCents` for what floor discarded.
     */
    monthlyCents: z.number().int().nonnegative(),
    /**
     * `annualisedCents % 12`, i.e. 0–11 cents. Returned rather than dropped so
     * the understatement in `monthlyCents` is stated instead of hidden.
     */
    monthlyRemainderCents: z.number().int().nonnegative(),
    /**
     * How many ACTIVE memberships sit on annually-billed tiers. The UI names
     * this whenever it is non-zero, because "monthly value" over a book that
     * is partly annual is a derived figure and a reader deserves to know the
     * derivation applied to them.
     */
    annualBilledCount: z.number().int().nonnegative(),
  })
  .strict();

export type RecurringRevenueCurrencyTotal = z.infer<
  typeof recurringRevenueCurrencyTotalSchema
>;

export const summariseRecurringRevenueOutputSchema = z
  .object({
    /**
     * One row per currency, currency-ascending. NEVER summed across rows.
     *
     * Named `ownerRevenueByCurrency`, not `revenueByCurrency`: memberships are
     * 0% platform fee, so this is money flowing TO owners and none of it is
     * ours. See the file header.
     */
    ownerRevenueByCurrency: z.array(recurringRevenueCurrencyTotalSchema),
    /** Live tiers behind these numbers. Context for an empty or thin result. */
    activeTierCount: z.number().int().nonnegative(),
    /**
     * False when the tier lookup degraded, in which case the totals cover only
     * the tiers that DID resolve. The UI says so rather than presenting a
     * partial book as the whole book.
     */
    tiersResolved: z.boolean(),
  })
  .strict();

export type SummariseRecurringRevenueOutput = z.infer<
  typeof summariseRecurringRevenueOutputSchema
>;

async function requireStaff(
  deps: SummariseRecurringRevenueDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: RECURRING_REVENUE_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

type CurrencyAccumulator = {
  currency: string;
  activeCount: number;
  trialingCount: number;
  annualisedCents: number;
  annualBilledCount: number;
};

export async function summariseRecurringRevenue(
  deps: SummariseRecurringRevenueDeps,
  rawInput: unknown,
): Promise<SummariseRecurringRevenueOutput> {
  const input = parseInput(summariseRecurringRevenueInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const grouped = await deps.repos.memberships.countByTierAndStatus({
    statuses: [REVENUE_STATUS_ACTIVE, REVENUE_STATUS_TRIALING],
    statementTimeoutMs: RECURRING_REVENUE_STATEMENT_TIMEOUT_MS,
  });

  const tierIds = [...new Set(grouped.map((row) => row.tierId))];

  // The tier read is BEST-EFFORT. A membership count with no tier behind it is
  // a count with no price and no currency, so a failed lookup cannot be
  // rendered as "$0" — that would report a healthy book as an empty one.
  // Instead the panel degrades to whatever resolved, and SAYS it degraded
  // (`tiersResolved: false`). Swallow + report (ReporterPort convention,
  // CLAUDE.md).
  let tiers: Awaited<
    ReturnType<Repos["membershipTiers"]["listByIds"]>
  > = [];
  let tiersResolved = false;
  try {
    tiers = tierIds.length > 0 ? await deps.repos.membershipTiers.listByIds(tierIds) : [];
    tiersResolved = true;
  } catch (err) {
    deps.logger?.error("recurring_revenue_tier_lookup_failed", { err });
    // GUARDED: a MISSING or THROWING reporter must never change behaviour.
    try {
      deps.reportError?.(err, {
        tags: { useCase: "summariseRecurringRevenue", step: "listTiers" },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }

  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));

  const byCurrency = new Map<string, CurrencyAccumulator>();
  for (const row of grouped) {
    const tier = tierById.get(row.tierId);
    // A count whose tier did not resolve is DROPPED rather than counted at
    // zero. Zero is a claim about money; absent is not.
    if (!tier) continue;

    const currency = tier.currency.toLowerCase();
    const acc = byCurrency.get(currency) ?? {
      currency,
      activeCount: 0,
      trialingCount: 0,
      annualisedCents: 0,
      annualBilledCount: 0,
    };

    if (row.status === REVENUE_STATUS_TRIALING) {
      // Counted, never valued — a trial has paid nothing.
      acc.trialingCount += row.count;
    } else {
      acc.activeCount += row.count;
      // Step 1 of the normalisation rule: annualise with integer multiplication
      // only. See the file header for why the division waits until the end.
      const perMembershipAnnualCents =
        tier.interval === "YEAR" ? tier.priceCents : tier.priceCents * 12;
      acc.annualisedCents += perMembershipAnnualCents * row.count;
      if (tier.interval === "YEAR") acc.annualBilledCount += row.count;
    }

    byCurrency.set(currency, acc);
  }

  const ownerRevenueByCurrency = [...byCurrency.values()]
    .map((acc) => ({
      currency: acc.currency,
      activeCount: acc.activeCount,
      trialingCount: acc.trialingCount,
      annualisedCents: acc.annualisedCents,
      // Steps 2 and 3: ONE division per currency, floored, remainder kept.
      monthlyCents: Math.floor(acc.annualisedCents / 12),
      monthlyRemainderCents: acc.annualisedCents % 12,
      annualBilledCount: acc.annualBilledCount,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    ownerRevenueByCurrency,
    // Tiers with at least one active or trialing member. Not the ACTIVE-status
    // tier count — a tier can be published with no subscribers, and this
    // number exists to explain the money above it.
    activeTierCount: tierById.size,
    tiersResolved,
  };
}
