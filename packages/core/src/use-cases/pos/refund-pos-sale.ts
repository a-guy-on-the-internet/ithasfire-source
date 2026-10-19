import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  refundFullOrder,
  type RefundFullOrderOutput,
} from "../orders/refund-full-order";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

// ── Schema ───────────────────────────────────────────────────────────────────

export const refundPosSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
});

export type RefundPosSaleInput = z.infer<typeof refundPosSaleInputSchema>;

export type RefundPosSaleOutput = RefundFullOrderOutput;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type RefundPosSaleDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /** Forwarded to refundFullOrder's ledger swallow branches. */
  reportError?: ReporterPort | null;
};

// ── Constants ────────────────────────────────────────────────────────────────

/** Spec FR-008 — gate-refund window is 15 min from order completion. */
const GATE_REFUND_WINDOW_MS = 15 * 60 * 1000;

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Refund a POS card sale at the gate (FR-008).
 *
 * Thin wrapper that authenticates against ORG_EDIT_ROLES, asserts the
 * order is paymentChannel=POS within the 15-min gate window, then
 * delegates the money path to the existing `refundFullOrder` use case
 * (which handles the Stripe refund + Settlement reversal + ticket state
 * flip). No new money path; reuses the web refund pipeline as required
 * by spec NFR-003.
 *
 * Older POS refunds and partial refunds must go through the web admin.
 */
export async function refundPosSale(
  deps: RefundPosSaleDeps,
  rawInput: unknown,
): Promise<RefundPosSaleOutput> {
  const input = parseInput(refundPosSaleInputSchema, rawInput);

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }

  const event = await deps.repos.events.getById(requireTicketingEventId(order));
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireOrgMembership({
    repos: deps.repos,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  const paymentChannel =
    (order as { paymentChannel?: "WEB" | "POS" | "CASH" }).paymentChannel ??
    "WEB";
  if (paymentChannel !== "POS") {
    throw fail("NOT_A_POS_CARD_ORDER");
  }

  const now = deps.clock.now();
  if (now.getTime() - order.occurredAt.getTime() > GATE_REFUND_WINDOW_MS) {
    throw {
      code: "forbidden",
      message: "gate_refund_window_expired",
      completedAt: order.occurredAt.toISOString(),
    } as const;
  }

  // Delegate to the existing refund pipeline. `_skipBuyerCheck` lets us
  // bypass the buyer-is-actor guard — for POS the actor is the operator,
  // not the phantom POS_WALKUP buyer. The 15-min window + ORG_EDIT_ROLES
  // check above is the equivalent authz. POS CARD sales finalize through the
  // same payment-intent webhook as web sales, so their SETTLEMENT_CREDITs
  // exist and refundFullOrder's REFUND_DEBIT write (spec §4) applies as-is.
  const result = await refundFullOrder(
    {
      repos: deps.repos,
      payments: deps.payments,
      idempotency: deps.idempotency,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
      _skipBuyerCheck: true,
    },
    {
      actorHumanId: input.actorHumanId,
      orderId: input.orderId,
      reason: "requested_by_customer",
    },
  );

  deps.logger?.info("pos.refund.gate_issued", {
    orderId: order.id,
    eventId: event.id,
    actorHumanId: input.actorHumanId,
    channel: "POS",
    refundedCents: result.refundedCents,
    refundId: result.refundId,
  });
  deps.metrics?.increment("pos.refund.gate_issued", {
    eventId: event.id,
    channel: "POS",
  });

  return result;
}
