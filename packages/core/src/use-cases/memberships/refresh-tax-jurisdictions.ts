import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";
import type { MembershipTaxJurisdictionRecord } from "@th/ports/repos/membership-tax-jurisdictions";

import { parseInput } from "../../lib/io";
import { ensureJurisdictionDefaultTaxRateIds } from "./ensure-jurisdiction-tax-rate";
import { MEMBERSHIP_LIVE_STATUSES } from "./membership-status";
import { membershipRateSource } from "./resolve-member-tax-jurisdiction";

/**
 * Scheduled re-confirmation of every cached membership tax rate.
 *
 * THIS IS THE ONLY THING THAT CATCHES A RATE CHANGE. Jurisdictions move their
 * rates on their own schedule — commonly quarterly boundaries — and produce no
 * member-side event when they do. An invalidation keyed on billing-address or
 * tier changes therefore cannot ever detect one, and a member who never moves
 * would be billed a stale rate indefinitely.
 *
 * On a changed rate the old row is ARCHIVED rather than mutated, and a
 * replacement is created. That is forced on us by Stripe: `TaxRate.percentage`
 * is immutable, so a rate change is always archive-and-replace there too, and
 * keeping our row shape aligned with Stripe's keeps the two migrations in step.
 * Memberships are then repointed at the replacement — in the DB AND on Stripe:
 * every LIVE subscription referencing the archived jurisdiction gets its
 * `default_tax_rates` repointed at the replacement's TaxRate (spec AC:
 * "migrates every subscription referencing it", with no member-side event to
 * lean on). Lapsed rows are skipped — nothing bills, and a resume re-resolves
 * fresh.
 *
 * The replacement is still created with `stripeTaxRateId = null` first: the
 * replacement's TaxRate is minted via `ensureJurisdictionDefaultTaxRateIds`
 * only when live subscriptions actually need migrating (or later, on first
 * use), so the archive/replace/repoint of our rows never holds a two-phase
 * commit open across our DB and Stripe's API.
 *
 * Per-membership Stripe failure policy: report + continue. The DB rows are
 * already repointed by then and the old row is archived (so a later run will
 * NOT retry it) — each failure is therefore reported to Sentry and collected
 * in the output for manual remediation; one bad subscription must not strand
 * the rest of the batch.
 */

export const refreshTaxJurisdictionsInputSchema = z
  .object({
    /**
     * Re-check rows confirmed longer ago than this. Default 7 days.
     *
     * NOT 90. Rates commonly change on quarter boundaries, so a 90-day window
     * would let a row checked on 15 December go unexamined until 15 March —
     * billing the old rate for ten weeks past a 1 January change. A weekly
     * window bounds that exposure to days, and the cost is trivial: this is one
     * provider call per distinct postal code, not per member.
     */
    maxAgeDays: z.number().int().positive().max(3650).default(7),
    /** Bound the batch so one run cannot exhaust the provider quota. */
    limit: z.number().int().positive().max(1000).default(200),
  })
  .strict();

export type RefreshTaxJurisdictionsInput = z.infer<
  typeof refreshTaxJurisdictionsInputSchema
>;

export type RefreshTaxJurisdictionsDeps = {
  repos: Repos;
  taxRateLookup: TaxRateLookupPort;
  /**
   * REQUIRED, not optional: a rate change must migrate every live Stripe
   * subscription off the archived TaxRate. This use case runs scheduled with
   * no human watching — an optional dep that silently skips the Stripe
   * migration would recreate the bill-the-archived-rate-forever bug, so a
   * misconfigured caller must fail loudly instead (the job wrapper throws
   * when billing is unconfigured).
   */
  membershipBilling: MembershipBillingPort;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
};

export type RefreshTaxJurisdictionsOutput = {
  examined: number;
  unchanged: number;
  changed: number;
  failed: number;
  membershipsMigrated: number;
  /** LIVE subscriptions whose Stripe `default_tax_rates` were repointed. */
  subscriptionsMigrated: number;
  /**
   * LIVE subscriptions the Stripe migration FAILED for. Each is also
   * reported to Sentry at failure time; the DB row already points at the
   * replacement, so these bill the archived rate until remediated by hand
   * (nothing retries them automatically — the old row is archived and will
   * never be listed as stale again).
   */
  subscriptionMigrationFailures: Array<{
    membershipId: string;
    stripeSubscriptionId: string;
  }>;
  /** True when the batch limit was hit, so the caller knows more remain. */
  truncated: boolean;
};

export async function refreshTaxJurisdictions(
  deps: RefreshTaxJurisdictionsDeps,
  rawInput: unknown = {},
): Promise<RefreshTaxJurisdictionsOutput> {
  const input = parseInput(refreshTaxJurisdictionsInputSchema, rawInput);
  const now = deps.clock.now();
  const staleBefore = new Date(
    now.getTime() - input.maxAgeDays * 24 * 60 * 60 * 1000,
  );

  const stale = await deps.repos.membershipTaxJurisdictions.listStale({
    staleBefore,
    limit: input.limit,
  });

  const result: RefreshTaxJurisdictionsOutput = {
    examined: stale.length,
    unchanged: 0,
    changed: 0,
    failed: 0,
    membershipsMigrated: 0,
    subscriptionsMigrated: 0,
    subscriptionMigrationFailures: [],
    truncated: stale.length === input.limit,
  };

  for (const jurisdiction of stale) {
    let looked_up: { rateBps: number; source: string } | null = null;
    try {
      looked_up = await deps.taxRateLookup.lookupByPostalCode({
        postalCode: jurisdiction.postalCode,
        countryCode: jurisdiction.countryCode,
      });
    } catch (err) {
      // One bad postal code must not abort the batch, but a silent failure
      // here leaves a stale rate billing indefinitely — which is the exact
      // failure this job exists to prevent, so it is reported, not just logged.
      result.failed += 1;
      deps.reportError?.(err, {
        tags: { useCase: "refreshTaxJurisdictions" },
        extra: {
          jurisdictionId: jurisdiction.id,
          countryCode: jurisdiction.countryCode,
          postalCode: jurisdiction.postalCode,
        },
      });
      deps.logger?.error("membership.tax.refresh_failed", {
        err,
        jurisdictionId: jurisdiction.id,
      });
      continue;
    }

    // A provider that answers "I don't know" is NOT evidence the rate became
    // zero. Leaving the row untouched keeps the last known-good rate rather
    // than silently zeroing a live jurisdiction.
    if (!looked_up) {
      result.failed += 1;
      deps.logger?.warn("membership.tax.refresh_no_rate", {
        jurisdictionId: jurisdiction.id,
      });
      continue;
    }

    if (looked_up.rateBps === jurisdiction.rateBps) {
      await deps.repos.membershipTaxJurisdictions.touchCheckedAt({
        id: jurisdiction.id,
        checkedAt: now,
      });
      result.unchanged += 1;
      continue;
    }

    // Changed: archive, replace, repoint. Order matters — the replacement is
    // created BEFORE the archive is visible to new signups only because both
    // happen inside the same request; the partial unique index on live rows
    // means the archive must land first or the insert would collide.
    //
    // The LIVE set is read BEFORE migrateMemberships repoints the rows —
    // afterwards nothing references the old jurisdiction and the set would be
    // empty by construction. Lapsed rows are excluded: a dead subscription
    // cannot be updated on Stripe, bills nothing, and a resume re-resolves
    // its jurisdiction wholesale.
    const liveMemberships =
      await deps.repos.memberships.listByTaxJurisdictionId({
        taxJurisdictionId: jurisdiction.id,
        statuses: [...MEMBERSHIP_LIVE_STATUSES],
      });

    await deps.repos.membershipTaxJurisdictions.archive({
      id: jurisdiction.id,
      archivedAt: now,
    });

    const replacement = await deps.repos.membershipTaxJurisdictions.create({
      countryCode: jurisdiction.countryCode,
      postalCode: jurisdiction.postalCode,
      rateBps: looked_up.rateBps,
      // Same provenance stamp the signup path writes, from the same helper —
      // an archived row and its replacement must not read as two different
      // kinds of rate when the only thing that changed is the number.
      rateSource: membershipRateSource(looked_up.source),
      checkedAt: now,
      effectiveFrom: now,
    });

    const { migratedCount } =
      await deps.repos.membershipTaxJurisdictions.migrateMemberships({
        fromJurisdictionId: jurisdiction.id,
        toJurisdictionId: replacement.id,
      });

    result.changed += 1;
    result.membershipsMigrated += migratedCount;

    deps.logger?.info("membership.tax.rate_changed", {
      jurisdictionId: jurisdiction.id,
      replacementId: replacement.id,
      fromRateBps: jurisdiction.rateBps,
      toRateBps: looked_up.rateBps,
      migratedCount,
      liveSubscriptions: liveMemberships.length,
    });

    await migrateLiveSubscriptions(deps, result, {
      oldJurisdictionId: jurisdiction.id,
      replacement,
      liveMemberships,
    });
  }

  return result;
}

/**
 * Repoint every LIVE subscription's Stripe `default_tax_rates` at the
 * replacement jurisdiction's TaxRate (minted here via
 * `ensureJurisdictionDefaultTaxRateIds` — an empty list is a genuine 0%
 * replacement, which the port contract CLEARS rates for).
 *
 * Failures are reported and collected, never thrown: by this point the DB
 * rows already reference the replacement and the old row is archived, so a
 * throw would strand every remaining subscription in the batch while fixing
 * nothing (no later run retries an archived row).
 */
async function migrateLiveSubscriptions(
  deps: RefreshTaxJurisdictionsDeps,
  result: RefreshTaxJurisdictionsOutput,
  args: {
    oldJurisdictionId: string;
    replacement: MembershipTaxJurisdictionRecord;
    liveMemberships: MembershipRecord[];
  },
): Promise<void> {
  if (args.liveMemberships.length === 0) return;

  let defaultTaxRateIds: string[];
  try {
    defaultTaxRateIds = await ensureJurisdictionDefaultTaxRateIds(
      { repos: deps.repos, membershipBilling: deps.membershipBilling },
      args.replacement,
    );
  } catch (err) {
    // The replacement's TaxRate could not be minted: EVERY live subscription
    // on this jurisdiction stays billing the archived rate. Report once,
    // record each one, keep going with the rest of the batch.
    for (const membership of args.liveMemberships) {
      result.subscriptionMigrationFailures.push({
        membershipId: membership.id,
        stripeSubscriptionId: membership.stripeSubscriptionId,
      });
    }
    deps.reportError?.(err, {
      tags: { useCase: "refreshTaxJurisdictions", step: "ensureTaxRate" },
      extra: {
        oldJurisdictionId: args.oldJurisdictionId,
        replacementJurisdictionId: args.replacement.id,
        liveSubscriptions: args.liveMemberships.length,
      },
    });
    deps.logger?.error("membership.tax.refresh_tax_rate_mint_failed", {
      err,
      replacementJurisdictionId: args.replacement.id,
    });
    return;
  }

  for (const membership of args.liveMemberships) {
    try {
      await deps.membershipBilling.updateSubscriptionTaxRates({
        subscriptionId: membership.stripeSubscriptionId,
        defaultTaxRateIds,
        // Keyed on (replacement jurisdiction, membership). There is no
        // Stripe event behind this path — the refresh run itself is the
        // retry unit — and the replacement id is minted fresh per rate
        // change, so a re-run of the SAME refresh replays the same key
        // safely (Stripe dedupes it) while a LATER rate change mints a new
        // replacement id and therefore a fresh key.
        idempotencyKey: `refresh-sub-tax:${args.replacement.id}:${membership.id}`,
      });
      result.subscriptionsMigrated += 1;
    } catch (err) {
      // One bad subscription must not strand the rest.
      result.subscriptionMigrationFailures.push({
        membershipId: membership.id,
        stripeSubscriptionId: membership.stripeSubscriptionId,
      });
      deps.reportError?.(err, {
        tags: {
          useCase: "refreshTaxJurisdictions",
          step: "updateSubscriptionTaxRates",
        },
        extra: {
          membershipId: membership.id,
          stripeSubscriptionId: membership.stripeSubscriptionId,
          replacementJurisdictionId: args.replacement.id,
        },
      });
      deps.logger?.error("membership.tax.refresh_subscription_migrate_failed", {
        err,
        membershipId: membership.id,
        stripeSubscriptionId: membership.stripeSubscriptionId,
      });
    }
  }
}
