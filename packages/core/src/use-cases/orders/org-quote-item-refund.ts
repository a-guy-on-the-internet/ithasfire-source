import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import {
  quoteItemRefund,
  quoteItemRefundOutputSchema,
} from "./quote-item-refund";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { refundOrderItemIdsSchema } from "./_shared/refund-item-ids";

export const orgQuoteItemRefundInputSchema = z.object({
  actorHumanId: z.uuid(),
  orgId: z.uuid(),
  orderId: z.uuid(),
  /** The specific order item IDs to refund. Each must belong to the order; no repeats. */
  orderItemIds: refundOrderItemIdsSchema,
});

export const orgQuoteItemRefundOutputSchema = quoteItemRefundOutputSchema;

export type OrgQuoteItemRefundInput = z.infer<
  typeof orgQuoteItemRefundInputSchema
>;
export type OrgQuoteItemRefundOutput = z.infer<
  typeof orgQuoteItemRefundOutputSchema
>;

export type OrgQuoteItemRefundDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  authz: AuthZPort;
  logger?: LoggerPort;
  /** Forwarded to {@link quoteItemRefund} (tax-line mismatch report). */
  reportError?: ReporterPort | null;
};

/**
 * Org-admin variant of {@link quoteItemRefund}.
 *
 * Authorizes the actor with ORG_FINANCE (OWNER/ADMIN/FINANCE) on the org, then
 * verifies the order actually belongs to an event owned by that org before
 * delegating to the shared item-refund quoting core (which computes all
 * fee/tax/eligibility math). The buyer-ownership guard in the shared core is
 * bypassed via the internal `_skipBuyerCheck` flag — org staff are not the
 * buyer, but they are authorized here by role + org ownership.
 */
export async function orgQuoteItemRefund(
  deps: OrgQuoteItemRefundDeps,
  rawInput: unknown,
): Promise<OrgQuoteItemRefundOutput> {
  const logger = deps.logger?.child({ useCase: "orgQuoteItemRefund" });
  const input = parseInput(orgQuoteItemRefundInputSchema, rawInput);

  // ── Authz: actor must hold at least FINANCE role on the org ──────────────
  const permission = await callOrDependencyFailed(
    () =>
      deps.authz.canFinanceOrg({
        actorHumanId: input.actorHumanId,
        orgId: input.orgId,
      }),
    logger,
    {
      action: "authz.canFinanceOrg",
      orgId: input.orgId,
      actorHumanId: input.actorHumanId,
    },
  );

  if (!permission.allowed) {
    throw fail("FORBIDDEN");
  }

  // ── Org ownership: the order's event must belong to this org ─────────────
  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId !== input.orgId) {
    throw fail("ORDER_NOT_IN_ORG");
  }

  // Delegate to the shared quoting core. All fee/tax/eligibility math lives
  // there — we do NOT reimplement it. Buyer check is bypassed after our authz.
  const quote = await quoteItemRefund(
    {
      repos: deps.repos,
      payments: deps.payments,
      logger,
      reportError: deps.reportError,
      _skipBuyerCheck: true,
    },
    {
      actorHumanId: input.actorHumanId,
      orderId: input.orderId,
      orderItemIds: input.orderItemIds,
    },
  );

  return orgQuoteItemRefundOutputSchema.parse(quote);
}
