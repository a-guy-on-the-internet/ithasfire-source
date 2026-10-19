import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { Repos } from "@th/ports/repos";
import type { MembershipRecord } from "@th/ports/repos/memberships";

import { parseInput } from "../../lib/io";

/**
 * Cancel a membership.
 *
 * Defaults to end-of-period, not immediate: a member who has already paid for
 * the current period keeps it. Immediate cancellation is a separate, explicit
 * decision (moderation, fraud) rather than something a mis-click can cause.
 *
 * Self-serve cancellation is ALSO available through Stripe's hosted portal,
 * and both paths matter — the commonest chargeback reason on recurring billing
 * is a member who could not work out how to stop paying.
 */

export const cancelMembershipInputSchema = z
  .object({
    membershipId: z.string().uuid(),
    /** Actor must be the member. Ownership is checked below. */
    actorHumanId: z.string().uuid(),
    immediate: z.boolean().optional().default(false),
  })
  .strict();

export type CancelMembershipInput = z.infer<typeof cancelMembershipInputSchema>;

export type CancelMembershipDeps = {
  repos: Repos;
  membershipBilling: MembershipBillingPort;
  logger?: LoggerPort;
};

export async function cancelMembership(
  deps: CancelMembershipDeps,
  rawInput: unknown,
): Promise<MembershipRecord> {
  const input = parseInput(cancelMembershipInputSchema, rawInput);

  const membership = await deps.repos.memberships.findById(input.membershipId);
  if (!membership) throw fail("MEMBERSHIP_NOT_FOUND");

  // Cancelling someone else's subscription would be a billing-grade IDOR.
  if (membership.memberHumanId !== input.actorHumanId) {
    throw fail("HUMAN_MISMATCH", { meta: { membershipId: membership.id } });
  }

  const snapshot = await deps.membershipBilling.cancelSubscription({
    subscriptionId: membership.stripeSubscriptionId,
    atPeriodEnd: !input.immediate,
    idempotencyKey: `membership-cancel:${membership.id}:${input.immediate ? "now" : "period_end"}`,
  });

  const updated = await deps.repos.memberships.updateFromStripe({
    id: membership.id,
    status: snapshot.status,
    currentPeriodStart: snapshot.currentPeriodStart,
    currentPeriodEnd: snapshot.currentPeriodEnd,
    cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
    canceledAt: snapshot.canceledAt,
  });

  deps.logger?.info("membership.canceled", {
    membershipId: membership.id,
    immediate: input.immediate,
    status: snapshot.status,
  });

  return updated;
}
