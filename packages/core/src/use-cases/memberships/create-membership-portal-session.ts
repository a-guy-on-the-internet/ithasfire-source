import { z } from "zod";

import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { MembershipBillingPort } from "@th/ports/membership-billing-port";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

/**
 * Mint a Stripe customer-portal session for a member.
 *
 * Load-bearing for dispute prevention, not a convenience: the single
 * commonest chargeback reason on recurring billing is a member who could not
 * find how to cancel.
 *
 * The membership MUST belong to the caller. The portal session exposes the
 * customer's card, invoices and every subscription on the Customer — minting
 * one against someone else's membership would be a full billing-account
 * takeover, so the mismatch is a hard HUMAN_MISMATCH, mirroring
 * cancelMembership.
 */

export const createMembershipPortalSessionInputSchema = z
  .object({
    /** The caller. Must be the membership's member. */
    actorHumanId: z.string().uuid(),
    membershipId: z.string().uuid(),
    /**
     * Where Stripe sends the member back. Built by the transport from the
     * public web URL — never accepted raw from the client, so the portal can
     * not be turned into an open redirect.
     */
    returnUrl: z.string().url().max(2_000),
  })
  .strict();

export type CreateMembershipPortalSessionInput = z.infer<
  typeof createMembershipPortalSessionInputSchema
>;

export const createMembershipPortalSessionOutputSchema = z
  .object({ url: z.string().url() })
  .strict();

export type CreateMembershipPortalSessionOutput = z.infer<
  typeof createMembershipPortalSessionOutputSchema
>;

export type CreateMembershipPortalSessionDeps = {
  repos: Repos;
  membershipBilling: MembershipBillingPort;
  logger?: LoggerPort;
};

export async function createMembershipPortalSession(
  deps: CreateMembershipPortalSessionDeps,
  rawInput: unknown,
): Promise<CreateMembershipPortalSessionOutput> {
  const input = parseInput(createMembershipPortalSessionInputSchema, rawInput);

  const membership = await deps.repos.memberships.findById(input.membershipId);
  if (!membership) throw fail("MEMBERSHIP_NOT_FOUND");

  if (membership.memberHumanId !== input.actorHumanId) {
    throw fail("HUMAN_MISMATCH", { meta: { membershipId: membership.id } });
  }

  const { url } = await deps.membershipBilling.createPortalSession({
    customerId: membership.stripeCustomerId,
    returnUrl: input.returnUrl,
  });

  deps.logger?.info("membership.portal_session.created", {
    membershipId: membership.id,
  });

  return createMembershipPortalSessionOutputSchema.parse({ url });
}
