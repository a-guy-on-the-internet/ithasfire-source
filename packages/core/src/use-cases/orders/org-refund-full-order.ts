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
  refundFullOrder,
  refundFullOrderOutputSchema,
} from "./refund-full-order";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";

export const orgRefundFullOrderInputSchema = z.object({
  actorHumanId: z.uuid(),
  orgId: z.uuid(),
  orderId: z.uuid(),
  reason: stripeRefundReasonSchema.optional(),
  /**
   * Free-form justification recorded in audit logs.
   * Required for org refunds so we have a paper trail of who refunded and why.
   */
  note: plainTextMultilineRequired(500).pipe(z.string().min(3)),
});

export const orgRefundFullOrderOutputSchema = refundFullOrderOutputSchema;

export type OrgRefundFullOrderInput = z.infer<
  typeof orgRefundFullOrderInputSchema
>;
export type OrgRefundFullOrderOutput = z.infer<
  typeof orgRefundFullOrderOutputSchema
>;

export type OrgRefundFullOrderDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  authz: AuthZPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Optional — forwarded to the
   * delegated refundFullOrder so the BUYER gets a fire-and-forget in-app
   * refund confirmation. The notify call lives in refundFullOrder (single
   * source) so buyer/staff/org full refunds can't double-notify.
   */
  notify?: NotifyFn;
  /**
   * Passed to refundFullOrder: tells a seller whose legacy listing the
   * refund closed how to list again (`sendLegacyRelistNotices`).
   */
  publicAppUrl?: string | null;
  /**
   * Forwarded to the delegated refundFullOrder so refund-debit swallows
   * (no_credits_for_order / clamp drift) reach Sentry from the org-finance
   * path too.
   */
  reportError?: ReporterPort | null;
};

/**
 * Org-admin variant of {@link refundFullOrder}.
 *
 * Authorizes the actor with ORG_FINANCE (OWNER/ADMIN/FINANCE) on the org, then
 * verifies the order belongs to an event owned by that org before delegating
 * to the shared full-refund core. All money handling — fee allocation, tax
 * shares, transfer reversal for paid-out items, the REFUND_DEBIT ledger rule,
 * the single buyer notification keyed on the refundId — lives in that core and
 * is NOT reimplemented here.
 *
 * This is the org's only path to refund a RESALE order: `refundOrderItems`
 * refuses RESALE (`RESALE_ORDER_USE_FULL_REFUND`) because only the full
 * refund performs the resale unwind (ticket back to the seller, listing
 * reopened, seller credit reversed). Before this wrapper existed, that unwind
 * was reachable only as the buyer or as platform staff.
 *
 * Idempotency: this wrapper deliberately does NOT namespace its own key.
 * `refundFullOrder` keys on `order:refund-full:{orderId}` for every caller
 * (buyer, staff, org). Unlike an item refund — where the org and the buyer
 * can legitimately refund DIFFERENT item subsets of the same order, so the
 * sibling `orgRefundOrderItems` isolates its keyspace — a full refund has
 * exactly one meaning per order. If the buyer and the org both ask for it,
 * the second request is a replay of the same refund, not a second refund:
 * sharing the key returns the stored result (inside the record's TTL) and
 * the status gate (`ORDER_ALREADY_REFUNDED`) refuses it after. A separate
 * org key would gain nothing and would let the org's Stripe idempotency key
 * miss the buyer's in-flight refund. The per-order refund mutex serializes
 * the two calls regardless of key.
 */
export async function orgRefundFullOrder(
  deps: OrgRefundFullOrderDeps,
  rawInput: unknown,
): Promise<OrgRefundFullOrderOutput> {
  const logger = deps.logger?.child({ useCase: "orgRefundFullOrder" });
  const input = parseInput(orgRefundFullOrderInputSchema, rawInput);

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

  // ── Delegate to the shared full-refund core ──────────────────────────────
  // Buyer ownership + buyer-only policy gates (refund window, scanned ticket,
  // nonRefundable) are bypassed after our authz — same as staffRefundOrder.
  const out = await refundFullOrder(
    {
      repos: deps.repos,
      payments: deps.payments,
      idempotency: deps.idempotency,
      clock: deps.clock,
      logger,
      notify: deps.notify,
      publicAppUrl: deps.publicAppUrl,
      reportError: deps.reportError,
      _skipBuyerCheck: true,
    },
    {
      actorHumanId: input.actorHumanId,
      orderId: input.orderId,
      reason: input.reason,
    },
  );

  // Attach the org actor + note to the audit log (second row, mirroring
  // orgRefundOrderItems — avoids changing the shared refund schema).
  //
  // `orderStatusAtRequest` keeps the row honest under the shared key: because
  // a full refund the BUYER already completed replays its stored result to
  // the org (inside the record's TTL), `refundId` alone would attribute the
  // buyer's refund to this actor. The status the order had when the org
  // asked — read above, before delegation — lets an auditor tell "the org's
  // own refund" (SUCCEEDED) from "the org retried / piggybacked on a refund
  // that had already landed" (REFUNDED).
  await deps.repos.tx(async (tx) => {
    await tx.audit.log({
      entity: "order",
      entityId: order.id,
      action: "org_full_refund_note",
      data: {
        orgId: input.orgId,
        actorHumanId: input.actorHumanId,
        refundId: out.refundId,
        note: input.note,
        orderStatusAtRequest: order.status,
      },
      at: deps.clock.now(),
    });
  });

  return orgRefundFullOrderOutputSchema.parse(out);
}
