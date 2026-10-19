import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import {
  deriveConnectCapabilities,
  syncConnectAccountBestEffort,
} from "./sync-connect-account";
import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  requireOrgMembership,
  ORG_EDIT_OR_FINANCE_ROLES,
} from "../../lib/rbac";

// ── Schema ───────────────────────────────────────────────────────────────────

export const getConnectStatusOrgInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    orgId: z.uuid(),
  })
  .strict();

export const getConnectStatusHumanInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    humanId: z.uuid(),
  })
  .strict();

export const getConnectStatusInputSchema = z.union([
  getConnectStatusOrgInputSchema,
  getConnectStatusHumanInputSchema,
]);

export type GetConnectStatusInput = z.infer<typeof getConnectStatusInputSchema>;

export const getConnectStatusOutputSchema = z.object({
  connected: z.boolean(),
  stripeAccountId: z.string().nullable(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  /**
   * Stripe's `details_submitted`. `null` means unknown: Stripe could not be
   * reached, so the result is the last-known row (charges / payouts) and there
   * is no basis for this value. Never `false` as a stand-in, which would tell
   * a finished account its onboarding is incomplete during a Stripe outage.
   */
  detailsSubmitted: z.boolean().nullable(),
  requirements: z
    .object({
      currentlyDue: z.array(z.string()),
      eventuallyDue: z.array(z.string()),
      pastDue: z.array(z.string()),
    })
    .nullable(),
  /**
   * Why payouts are off, when Stripe's own dashboard would say they're on.
   *
   * `payoutsEnabled` here is stricter than Stripe's `payouts_enabled` (it ANDs
   * the `transfers` capability, and it reflects our row when a write was
   * skipped). Without a reason the organizer sees "Payouts enabled: No" with an
   * empty requirements list and nothing to act on — the same "two surfaces
   * disagree" experience the incident was about, moved one layer out.
   */
  payoutsBlockedReason: z
    .enum(["transfers_capability_pending", "account_restricted"])
    .nullable(),
  /**
   * What Stripe itself reported, when the dev capability override changed the
   * answer. `chargesEnabled` / `payoutsEnabled` above are what the publish gate
   * reads, and on a dev/test server (`forceConnectCapabilities`) that can be
   * `true` for an account Stripe has not enabled. A money screen states what
   * Stripe reports, so the page needs Stripe's own values to show beside the
   * override. `null` whenever the override was off or did not change anything.
   * Production never forces, so this is always `null` there.
   *
   * When forced and Stripe could not be reached, the row may hold an earlier
   * forced `true`, so a row with anything on is reported as overridden with
   * Stripe's values `null` (unknown): the page must not call it set up.
   */
  capabilityOverride: z
    .object({
      stripeChargesEnabled: z.boolean().nullable(),
      stripePayoutsEnabled: z.boolean().nullable(),
    })
    .nullable(),
});

export type GetConnectStatusOutput = z.infer<
  typeof getConnectStatusOutputSchema
>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type GetConnectStatusDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  clock?: ClockPort;
  /**
   * Required by the repo's error convention: this use case deliberately
   * swallows a Stripe failure and returns degraded (stale DB) data, and that
   * swallow must not be invisible. See the catch branch below.
   */
  reportError?: ReporterPort;
  /**
   * Dev-only: mirror the `account.updated` bypass so a live read cannot flip
   * seeded Custom accounts (which never finish onboarding) back to PENDING.
   * Production must never pass `true`.
   */
  forceConnectCapabilities?: boolean;
};

type ConnectOwner = {
  subjectType: "ORGANIZATION" | "HUMAN";
  subjectId: string;
  logContext: { orgId: string } | { humanId: string };
};

async function resolveConnectOwner(
  deps: GetConnectStatusDeps,
  input: GetConnectStatusInput,
): Promise<ConnectOwner> {
  if ("orgId" in input) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_EDIT_OR_FINANCE_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });

    return {
      subjectType: "ORGANIZATION",
      subjectId: input.orgId,
      logContext: { orgId: input.orgId },
    };
  }

  if (input.humanId !== input.actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER");
  }

  return {
    subjectType: "HUMAN",
    subjectId: input.humanId,
    logContext: { humanId: input.humanId },
  };
}

// ── Use case ─────────────────────────────────────────────────────────────────

const NOT_CONNECTED: GetConnectStatusOutput = {
  connected: false,
  stripeAccountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirements: null,
  payoutsBlockedReason: null,
  capabilityOverride: null,
};

export async function getConnectStatus(
  deps: GetConnectStatusDeps,
  rawInput: unknown,
): Promise<GetConnectStatusOutput> {
  const input = parseInput(getConnectStatusInputSchema, rawInput);
  const owner = await resolveConnectOwner(deps, input);

  // Look up Payee for this owner
  const payeeRef = await deps.repos.payees.getBySubject({
    type: owner.subjectType,
    id: owner.subjectId,
  });

  if (!payeeRef) return NOT_CONNECTED;

  const payee = await deps.repos.payees.getById(payeeRef.id);
  if (!payee?.stripeAccountId) return NOT_CONNECTED;

  // Fetch live status from Stripe
  try {
    // Stamped BEFORE the read: `observedAt` records when this state was true,
    // not when we wrote it. Taken afterwards, an `account.updated` for a change
    // that lands during the read window would carry an earlier `event.created`
    // than our stamp and lose the ordering guard to our now-stale snapshot.
    const observedAt = deps.clock?.now() ?? new Date();
    const status = await deps.payments.getConnectAccountStatus({
      accountId: payee.stripeAccountId,
    });

    // ── Self-heal: persist what we just learned ──────────────────────────
    // This read is the ONLY place in the product that sees live Stripe
    // capability state. Before, it discarded that state and the `Payee` row
    // could only ever be written by an `account.updated` webhook — so a single
    // missed/mis-parsed/out-of-order delivery left the row stale forever and
    // the publish gate (which reads the row) refused a paid event while this
    // very page rendered green. Writing back turns that permanent outage into
    // a self-heal on any Payments-settings load.
    //
    // One case is NOT self-healed: a RESTRICTED payee (Connect authorization
    // revoked) is skipped by the repo's guard on purpose, so re-onboarding does
    // not clear it. That path logs at error level instead — see
    // `syncConnectAccount`.
    //
    // Best-effort by construction: the write must never break the read, but a
    // silent failure would restore the divergence, so it reports to Sentry.
    const snapshot = {
      stripeAccountId: payee.stripeAccountId,
      chargesEnabled: status.chargesEnabled,
      payoutsEnabled: status.payoutsEnabled,
      // MUST be forwarded. `deriveConnectCapabilities` ANDs `transfers` into
      // `payoutsEnabled`; dropping capabilities here would make this path the
      // more permissive of the two and — being the newer observation — it would
      // always beat the webhook's stricter answer.
      capabilities: status.capabilities ?? null,
      // Normalized {currentlyDue,eventuallyDue,pastDue} rather than the raw
      // Stripe shape a webhook stores. `Payee.requirements` has no readers
      // (grep: write-only audit data), so the shape difference is inert.
      requirements: status.requirements,
      // `getConnectAccountStatus` doesn't surface the account's default
      // currency; leave the stored value alone rather than guessing.
      defaultCurrency: payee.defaultCurrency,
    };
    const forceEnabled = deps.forceConnectCapabilities === true;

    const synced = await syncConnectAccountBestEffort(
      {
        repos: deps.repos,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        account: snapshot,
        observedAt,
        source: "live-read",
        forceEnabled,
      },
    );

    // Report what the PUBLISH GATE will read, not what Stripe said.
    //
    // When the write applied, those are the same thing — return the derived
    // values (this is also what stops the dev capability override from
    // rendering "not set up" on a page whose Publish button works).
    //
    // When it did NOT apply, show the row — reporting the derived values would
    // put us straight back in the incident: green page, refused publish. But
    // show the row AS IT IS NOW, re-read, not the snapshot from before the
    // Stripe call. `skipped_stale` means a webhook with a newer `event.created`
    // won the ordering guard DURING our read window, so the pre-read snapshot
    // is precisely the value the gate no longer holds — rendering it re-opens
    // the page/gate divergence for the length of that window. The reconcile
    // sweep re-reads before comparing for the same reason. (RESTRICTED is the
    // other non-applied case; the re-read returns the same blocked row.)
    const applied = synced?.outcome === "applied";
    let derived: { chargesEnabled: boolean; payoutsEnabled: boolean };
    if (applied) {
      derived = deriveConnectCapabilities(snapshot, forceEnabled);
    } else {
      const rowNow = (await deps.repos.payees.getById(payee.id)) ?? payee;
      derived = {
        chargesEnabled: rowNow.chargesEnabled,
        payoutsEnabled: rowNow.payoutsEnabled,
      };
    }

    // Explain a "no" that Stripe's own dashboard would call a "yes".
    let payoutsBlockedReason: GetConnectStatusOutput["payoutsBlockedReason"] =
      null;
    if (!derived.payoutsEnabled) {
      if (synced?.outcome === "skipped_restricted") {
        payoutsBlockedReason = "account_restricted";
      } else if (
        status.payoutsEnabled &&
        snapshot.capabilities &&
        snapshot.capabilities.transfers !== "active"
      ) {
        payoutsBlockedReason = "transfers_capability_pending";
      }
    }

    // Only the dev override can make the page say "on" where Stripe says
    // "off"; say so, with Stripe's own values, so the page never claims an
    // account is set up on the override's word alone. Flag only a value the
    // override turned ON: a non-applied write (RESTRICTED, or a newer webhook
    // won) re-reads the row, and a row that is OFF where Stripe says on is the
    // guard's doing, not the override's.
    const overridden =
      forceEnabled &&
      ((derived.chargesEnabled && !status.chargesEnabled) ||
        (derived.payoutsEnabled && !status.payoutsEnabled));
    const capabilityOverride: GetConnectStatusOutput["capabilityOverride"] =
      overridden
        ? {
            stripeChargesEnabled: status.chargesEnabled,
            stripePayoutsEnabled: status.payoutsEnabled,
          }
        : null;

    return {
      connected: true,
      stripeAccountId: payee.stripeAccountId,
      chargesEnabled: derived.chargesEnabled,
      payoutsEnabled: derived.payoutsEnabled,
      detailsSubmitted: status.detailsSubmitted,
      requirements: status.requirements,
      payoutsBlockedReason,
      capabilityOverride,
    };
  } catch (err) {
    // Deliberate swallow: a Stripe outage degrades this page to the last-known
    // DB values rather than failing it. Per the repo's error convention that
    // swallow MUST be reported — `logger.warn` is not captured by Sentry, so
    // without this a Stripe outage silently served stale connect state
    // everywhere (including into the write-back above) with zero visibility.
    deps.logger?.error("stripe_connect_status_fetch_failed", {
      ...owner.logContext,
      stripeAccountId: payee.stripeAccountId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      deps.reportError?.(err, {
        tags: { area: "stripe-connect", op: "get-connect-status" },
        extra: {
          ...owner.logContext,
          stripeAccountId: payee.stripeAccountId,
        },
      });
    } catch {
      // A throwing reporter must never change behaviour.
    }

    // On a forcing server an earlier read wrote the override's `true` into
    // the row, so the row alone cannot say Stripe enabled anything. Mark it
    // overridden with Stripe's answer unknown. Production never forces, so its
    // fallback stays the plain last-known row.
    const capabilityOverride: GetConnectStatusOutput["capabilityOverride"] =
      deps.forceConnectCapabilities === true &&
      (payee.chargesEnabled || payee.payoutsEnabled)
        ? { stripeChargesEnabled: null, stripePayoutsEnabled: null }
        : null;

    // Return what we know from our DB
    return {
      connected: true,
      stripeAccountId: payee.stripeAccountId,
      chargesEnabled: payee.chargesEnabled,
      payoutsEnabled: payee.payoutsEnabled,
      // Unknown, not false: see the schema.
      detailsSubmitted: null,
      requirements: null,
      // We couldn't reach Stripe, so we have no basis for a reason.
      payoutsBlockedReason: null,
      capabilityOverride,
    };
  }
}
