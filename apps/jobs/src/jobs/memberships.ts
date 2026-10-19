/**
 * Membership maintenance.
 *
 * memberships.report-health — daily count of the three ways the membership
 * book quietly breaks: failing cards, abandoned signups, and members about to
 * leave. Before it existed, `past_due` was watched by NOTHING — it is a known
 * constant that DENIES benefits at checkout, so a failed card silently killed
 * a member's perks and the first anyone heard was a complaint.
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

import {
  refreshTaxJurisdictions,
  reportMembershipHealth,
  reportMembershipHealthInputSchema,
} from "@th/core/use-cases/memberships";
import { logAndAlert } from "@th/adapters/infra/discord-alerts";

import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import { buildCloudLoggingUrl, fireDiscordAlert } from "../lib/discord-alerts";

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

// ─────────────────────────────────────────────────────────────────────────────
// memberships.report-health
//
// DAILY, and that is the argued choice. Every signal here is measured in DAYS:
// Stripe's dunning retries run over roughly two weeks, an abandoned signup is
// graded against a 24h grace window, and a scheduled cancellation is a
// two-week deadline. An hourly read — the cadence its sibling
// `moderation.report-queue-health` uses — would re-examine the same rows
// twenty-four times a day to learn nothing, and nothing here degrades fast
// enough for an hour to matter. A dead moderation drain starts holding uploads
// within minutes; a failing card does not become more urgent between 02:00 and
// 03:00.
//
// 06:30 UTC: after the nightly analytics and payout windows, so a run that
// pages lands in a channel a human reads in the morning rather than at 3am,
// and on a :00/:30 slot the */30 jobs already wake the database for (moved
// from 06:15 on 2026-10-08, when the quarter-hour slots went away).
// ─────────────────────────────────────────────────────────────────────────────

export const reportMembershipHealthJob = defineScheduledTask({
  name: "memberships.report-health",
  description:
    "Daily health read over the membership book: memberships whose card is " +
    "failing (past_due / unpaid — benefits are ALREADY denied at checkout), " +
    "signups stuck at 'incomplete' past the grace window, and memberships " +
    "set to end inside the warning window. The Discord alert is " +
    "edge-triggered: it fires when the set of firing signals changes, or " +
    "when an unchanged picture goes stale. Two of the three counts never " +
    "return to zero without a human, so a level trigger would post the same " +
    "message every day forever.",
  input: reportMembershipHealthInputSchema,
  schedule: getSchedule("memberships.report-health"),
  handler: async ({ input, ctx }) => {
    const result = await reportMembershipHealth(
      {
        repos: {
          memberships: ctx.repos.memberships,
          // Edge-trigger state: the fingerprint of the last problem picture
          // actually paged out. Uncached in the jobs container (only the API
          // wraps platformSettings in a TTL cache), so this read sees the row
          // the previous run wrote.
          platformSettings: ctx.repos.platformSettings,
        },
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError,
      },
      input,
    );

    // `shouldAlert`, not `unhealthy` — the use case owns the suppression
    // decision; this layer only obeys it and holds the webhook.
    if (result.shouldAlert) {
      const logsUrl = buildCloudLoggingUrl(ctx.runId);
      const fields = [
        {
          name: "Card failing",
          value: String(result.counts.paymentFailing),
          inline: true,
        },
        {
          name: "Signup stuck",
          value: String(result.counts.stuckIncomplete),
          inline: true,
        },
        {
          name: "Leaving soon",
          value: String(result.counts.leavingSoon),
          inline: true,
        },
      ];
      if (logsUrl) {
        fields.push({ name: "Logs", value: logsUrl, inline: false });
      }

      // logAndAlert (not logAndReport): this is an operational signal, not a
      // thrown error, and the underlying sender is env-gated + swallows its
      // own failures — an unreachable Discord must never fail a health check.
      await logAndAlert({
        logger: ctx.logger,
        level: "warn",
        message: "memberships.report-health.unhealthy",
        extra: {
          runId: ctx.runId,
          ...result.counts,
          alertReason: result.alertReason,
          fingerprint: result.fingerprint,
        },
        alert: {
          send: fireDiscordAlert,
          payload: {
            title:
              result.alertReason === "heartbeat"
                ? "Memberships — still unresolved"
                : "Memberships need attention",
            colour: "warning",
            description:
              result.alertReason === "heartbeat"
                ? `${result.problems.join("\n\n")}\n\n_Unchanged since the last alert; this is the periodic reminder, not a new problem._`
                : result.problems.join("\n\n"),
            fields,
          },
        },
      });
    }

    // Fires every run regardless of whether anything was sent, so the daily
    // read stays visible in logs even while the Discord channel is quiet.
    ctx.logger.info("memberships.report-health.completed", {
      ...result.counts,
      unhealthy: result.unhealthy,
      shouldAlert: result.shouldAlert,
      alertReason: result.alertReason,
      fingerprint: result.fingerprint,
    });
    return result;
  },
});

export const membershipJobs = [
  refreshMembershipTaxJurisdictions,
  reportMembershipHealthJob,
];
