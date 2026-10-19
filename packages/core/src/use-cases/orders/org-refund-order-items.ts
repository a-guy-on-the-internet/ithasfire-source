import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { stripeRefundReasonSchema } from "@th/schema";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import type { NotifyFn } from "./notify-buyer";
import {
  refundOrderItems,
  refundOrderItemsOutputSchema,
} from "./refund-order-items";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { refundOrderItemIdsSchema } from "./_shared/refund-item-ids";

export const orgRefundOrderItemsInputSchema = z.object({
  actorHumanId: z.uuid(),
  orgId: z.uuid(),
  orderId: z.uuid(),
  /** Specific order item IDs to refund. Each must belong to the order; no repeats. */
  orderItemIds: refundOrderItemIdsSchema,
  reason: stripeRefundReasonSchema.optional(),
  /**
   * Free-form justification recorded in audit logs.
   * Required for org refunds so we have a paper trail of who refunded and why.
   */
  note: plainTextMultilineRequired(500).pipe(z.string().min(3)),
});

export const orgRefundOrderItemsOutputSchema = refundOrderItemsOutputSchema;

export type OrgRefundOrderItemsInput = z.infer<
  typeof orgRefundOrderItemsInputSchema
>;
export type OrgRefundOrderItemsOutput = z.infer<
  typeof orgRefundOrderItemsOutputSchema
>;

export type OrgRefundOrderItemsDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Optional — forwarded to the
   * delegated refundOrderItems so the BUYER gets a fire-and-forget in-app
   * refund confirmation. The notify call lives in refundOrderItems (single
   * source) so buyer/staff/org refunds can't double-notify.
   */
  notify?: NotifyFn;
  /**
   * Forwarded to the delegated refundOrderItems so refund-debit swallows
   * (no_credits_for_order / clamp drift) reach Sentry from the org-finance
   * path too (Step C review, BLOCKING).
   */
  reportError?: ReporterPort | null;
};

/**
 * Org-admin variant of {@link refundOrderItems}.
 *
 * Authorizes the actor with ORG_FINANCE (OWNER/ADMIN/FINANCE) on the org, then
 * verifies the order belongs to an event owned by that org before delegating
 * to the shared item-refund core. All money handling — PASS_THROUGH platform
 * fee refunded, only the Stripe processing fee withheld, tax refunded
 * proportionally, transfer reversal for paid-out items, double-refund
 * prevention via item status, and the single buyer notification keyed on the
 * refundId — lives in that shared core and is NOT reimplemented here.
 *
 * A DISTINCT idempotency-key prefix (`order:org-refund-items:...`) keeps org
 * refund records from ever colliding with the buyer/staff keyspace.
 */
export async function orgRefundOrderItems(
  deps: OrgRefundOrderItemsDeps,
  rawInput: unknown,
): Promise<OrgRefundOrderItemsOutput> {
  const logger = deps.logger?.child({ useCase: "orgRefundOrderItems" });
  const input = parseInput(orgRefundOrderItemsInputSchema, rawInput);

  // ── Authz: actor must hold at least FINANCE role on the org ──────────────
  // This explicit check runs BEFORE any refund side-effect.
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

  // ── Delegate to the shared item-refund core ──────────────────────────────
  // A distinct idempotency key isolates org refunds from buyer/staff keys.
  const out = await refundOrderItems(
    {
      repos: deps.repos,
      payments: deps.payments,
      idempotency: deps.idempotency,
      clock: deps.clock,
      logger,
      notify: deps.notify,
      reportError: deps.reportError,
      _skipBuyerCheck: true,
      _idempotencyKey: buildOrgRefundOrderItemsIdempotencyKey({
        orgId: input.orgId,
        orderId: order.id,
        orderItemIds: input.orderItemIds,
      }),
    },
    {
      actorHumanId: input.actorHumanId,
      orderId: input.orderId,
      orderItemIds: input.orderItemIds,
      reason: input.reason,
    },
  );

  // Attach the org actor + note to the audit log (second row, mirroring
  // staffRefundOrder — avoids changing the shared refund schema).
  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "order",
      entityId: order.id,
      action: "org_refund_note",
      data: {
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        refundId: out.refundId,
        note: input.note,
      },
      at: deps.clock.now(),
    });
  });

  return orgRefundOrderItemsOutputSchema.parse(out);
}

function buildOrgRefundOrderItemsIdempotencyKey(input: {
  orgId: string;
  orderId: string;
  orderItemIds: string[];
}): string {
  return [
    "order:org-refund-items",
    input.orgId,
    input.orderId,
    "items",
    ...[...input.orderItemIds].sort(),
  ].join(":");
}
