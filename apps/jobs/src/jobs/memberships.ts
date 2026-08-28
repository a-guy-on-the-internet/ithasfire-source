/**
 * Membership maintenance.
 *
 * memberships.refresh-tax-jurisdictions — re-confirms every cached membership
 * tax rate against the provider.
 *
 * Why this job exists at all: membership tax is DESTINATION-sourced, so the
 * rate belongs to the member's postal code rather than to the venue. Postal
 * codes change their rates on their own schedule — commonly quarter
 * boundaries — and produce NO member-side event when they do. No signup, no
 * address edit, no tier change. So this cron is the only thing in the system
 * capable of noticing, and without it a member who never moves would be billed
 * a stale rate for as long as their subscription lives. Since we are merchant
 * of record, that shortfall is ours to owe.
 *
 * The staleness window (default 7 days) is deliberately much shorter than the
 * quarterly cadence of real rate changes: a 90-day window would let a row
 * checked in mid-December go unexamined until mid-March, ten weeks past a
 * 1 January change. Cost is one provider call per distinct postal code — not
 * per member — so a tight window is cheap.
 */
import { z } from "zod";

import { refreshTaxJurisdictions } from "@th/core/use-cases/memberships";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";

export const refreshMembershipTaxJurisdictions = defineScheduledTask({
  name: "memberships.refresh-tax-jurisdictions",
  description:
    "Re-confirm cached membership tax rates, archiving and replacing changed ones and repointing affected subscriptions.",
  input: z.object({
    /** Re-check rows confirmed longer ago than this. */
    maxAgeDays: z.coerce.number().int().min(1).max(3650).optional(),
    /** Bound the batch so one run cannot exhaust the provider quota. */
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  }),
  schedule: getSchedule("memberships.refresh-tax-jurisdictions"),
  handler: async ({ input, ctx }) => {
    // An unconfigured provider is NOT evidence that every jurisdiction stopped
    // taxing. Skipping keeps the last known-good rates; proceeding would count
    // every row as failed and, worse, invites a future change that treats a
    // missing provider as a zero rate.
    if (!ctx.taxRateLookup) {
      ctx.logger.warn("memberships.refresh_tax_jurisdictions.skipped", {
        reason: "ziptax_not_configured",
      });
      // A logger.warn is NOT Sentry-captured (CLAUDE.md), so a missing key
      // would make this job a permanent silent no-op — every rate frozen at
      // whatever it was when last seen, with nothing anywhere saying so.
      // Report it so a cleared or omitted secret is loud. Guarded, per the
      // convention, so a throwing reporter never changes job behaviour.
      try {
        ctx.reportError(
          new Error("membership_tax_refresh_ziptax_not_configured"),
          { tags: { area: "membership-tax" } },
        );
      } catch {
        // best-effort only
      }
      return {
        skipped: true as const,
        reason: "ziptax_not_configured" as const,
      };
    }

    // Billing is REQUIRED, unlike ZipTax above, and the difference is
    // deliberate. A missing rate provider means "we learned nothing new, leave
    // every live rate alone" — safe to skip. A missing BILLING client means we
    // could still archive a jurisdiction and repoint our own rows while every
    // live Stripe subscription keeps billing the archived TaxRate forever.
    // That is the exact bug the migration step exists to prevent, so refuse
    // the run instead of half-performing it.
    if (!ctx.membershipBilling) {
      throw new Error(
        "membership_tax_refresh_billing_not_configured: STRIPE_SECRET_KEY is required to migrate subscriptions off archived tax rates",
      );
    }

    const result = await refreshTaxJurisdictions(
      {
        repos: ctx.repos,
        taxRateLookup: ctx.taxRateLookup,
        membershipBilling: ctx.membershipBilling,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      {
        ...(input.maxAgeDays === undefined
          ? {}
          : { maxAgeDays: input.maxAgeDays }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    );

    // `truncated` means the batch cap was hit and more stale rows remain. Log
    // it loudly rather than letting a full batch read as full coverage — a
    // silent cap here would look identical to "everything is fresh".
    if (result.truncated) {
      ctx.logger.warn("memberships.refresh_tax_jurisdictions.truncated", {
        examined: result.examined,
      });
    }

    return { skipped: false as const, ...result };
  },
});

export const membershipJobs = [refreshMembershipTaxJurisdictions];
