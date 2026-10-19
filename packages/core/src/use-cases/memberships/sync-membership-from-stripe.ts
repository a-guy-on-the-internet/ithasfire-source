import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * Mirror a Stripe subscription's lifecycle state onto our `Membership` row.
 *
 * Driven by `customer.subscription.updated` and `customer.subscription.deleted`.
 * Stripe Billing is the source of truth for subscription state — dunning,
 * cancellation, pauses and the end of a trial all happen there — so this use
 * case is a pure mirror and deliberately owns no policy of its own.
 *
 * ── An untracked subscription is a NO-OP, not an error ────────────────────────
 * The platform Stripe account carries subscriptions we did not create: anything
 * made from the Dashboard, anything from a different product line, and (during
 * a migration) anything predating our tables. Those events are normal traffic.
 *
 * So this logs at INFO and returns, and it deliberately does NOT take a
 * `ReporterPort`. Per CLAUDE.md, `reportError` exists for *deliberate swallows*
 * — a failure we caught and degraded past. This is not one: nothing failed. A
 * subscription we do not track is a correct, expected answer to a question we
 * asked, and reporting it would fill Sentry with routine traffic and bury the
 * outages the convention exists to surface. (The same argument the spec makes
 * for `TAX_JURISDICTION_UNSUPPORTED`.)
 *
 * If the repo WRITE fails, that is a genuine failure and it throws — the webhook
 * DLQ catches it, and the event can be replayed once the cause is fixed.
 */

export const syncMembershipFromStripeInputSchema = z
  .object({
    stripeSubscriptionId: z.string().trim().min(3).max(255),
    /** Stripe's status verbatim: active | past_due | canceled | unpaid | ... */
    status: z.string().trim().min(1).max(64),
    currentPeriodStart: z.coerce.date().nullable().optional(),
    currentPeriodEnd: z.coerce.date().nullable().optional(),
    cancelAtPeriodEnd: z.boolean().nullable().optional(),
    canceledAt: z.coerce.date().nullable().optional(),
    stripeEventId: z.string().trim().min(3).max(255),
  })
  .strict();

export const syncMembershipFromStripeOutputSchema = z
  .object({
    ok: z.literal(true),
    /** Null when the subscription is not one of ours. */
    membershipId: z.string().uuid().nullable(),
    applied: z.boolean(),
    /** Why nothing was written. Null when `applied` is true. */
    skippedReason: z
      .enum(["untracked_subscription", "stale_event"])
      .nullable()
      .default(null),
    status: z.string().nullable().default(null),
  })
  .strict();

export type SyncMembershipFromStripeInput = z.infer<
  typeof syncMembershipFromStripeInputSchema
>;
export type SyncMembershipFromStripeOutput = z.infer<
  typeof syncMembershipFromStripeOutputSchema
>;

export type SyncMembershipFromStripeDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
};

export async function syncMembershipFromStripe(
  deps: SyncMembershipFromStripeDeps,
  rawInput: unknown,
): Promise<SyncMembershipFromStripeOutput> {
  const input = parseInput(syncMembershipFromStripeInputSchema, rawInput);

  return deps.repos.tx(async (tx) => {
    const membership = await tx.memberships.findByStripeSubscriptionId(
      input.stripeSubscriptionId,
    );

    if (!membership) {
      // Normal condition — see the header. INFO, no report, no throw.
      deps.logger?.info("membership.sync_skipped_untracked_subscription", {
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeEventId: input.stripeEventId,
        status: input.status,
      });
      return syncMembershipFromStripeOutputSchema.parse({
        ok: true,
        membershipId: null,
        applied: false,
        skippedReason: "untracked_subscription",
        status: null,
      });
    }

    // ── Out-of-order delivery guard ─────────────────────────────────────────
    // Stripe does not guarantee webhook ordering and retries arrive late, so a
    // stale delivery can otherwise clobber newer state (the same failure mode
    // `payees.syncCapabilities` guards with `observedAt`). We have no observed-at
    // column here, so the billing period is the available monotonic signal: a
    // subscription's period only ever moves forward. An event describing a
    // STRICTLY OLDER period is therefore stale by construction.
    //
    // Equal periods still apply — that is where cancelAtPeriodEnd flips and
    // where dunning moves status within one period, which is most of the
    // traffic. This narrows the race; it does not close it.
    if (
      input.currentPeriodStart &&
      input.currentPeriodStart.getTime() < membership.currentPeriodStart.getTime()
    ) {
      deps.logger?.info("membership.sync_skipped_stale_event", {
        membershipId: membership.id,
        stripeEventId: input.stripeEventId,
        eventPeriodStart: input.currentPeriodStart.toISOString(),
        storedPeriodStart: membership.currentPeriodStart.toISOString(),
      });
      return syncMembershipFromStripeOutputSchema.parse({
        ok: true,
        membershipId: membership.id,
        applied: false,
        skippedReason: "stale_event",
        status: membership.status,
      });
    }

    // Only the fields Stripe actually told us about. `updateFromStripe` leaves
    // omitted fields untouched, so a partial event cannot null out good state.
    const updated = await tx.memberships.updateFromStripe({
      id: membership.id,
      status: input.status,
      ...(input.currentPeriodStart
        ? { currentPeriodStart: input.currentPeriodStart }
        : {}),
      ...(input.currentPeriodEnd
        ? { currentPeriodEnd: input.currentPeriodEnd }
        : {}),
      ...(input.cancelAtPeriodEnd == null
        ? {}
        : { cancelAtPeriodEnd: input.cancelAtPeriodEnd }),
      ...(input.canceledAt === undefined
        ? {}
        : { canceledAt: input.canceledAt }),
    });

    await tx.audit.log({
      entity: "membership",
      entityId: membership.id,
      action: "synced_from_stripe",
      data: {
        stripeEventId: input.stripeEventId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        previousStatus: membership.status,
        status: updated.status,
        cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
        canceledAt: updated.canceledAt?.toISOString() ?? null,
        currentPeriodEnd: updated.currentPeriodEnd?.toISOString() ?? null,
      },
      at: deps.clock.now(),
    });

    deps.logger?.info("membership.synced_from_stripe", {
      membershipId: membership.id,
      stripeEventId: input.stripeEventId,
      previousStatus: membership.status,
      status: updated.status,
    });

    return syncMembershipFromStripeOutputSchema.parse({
      ok: true,
      membershipId: membership.id,
      applied: true,
      skippedReason: null,
      status: updated.status,
    });
  });
}
