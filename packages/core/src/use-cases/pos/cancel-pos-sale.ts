import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { voidPendingPosOrder } from "./_shared/void-pending-pos-order";

// ── Schema ───────────────────────────────────────────────────────────────────

export const cancelPosSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  orderId: z.string().uuid(),
  /** Our `pos_readers.id`, when the sale was dispatched to a reader. */
  posReaderId: z.string().uuid().optional(),
});

export type CancelPosSaleInput = z.infer<typeof cancelPosSaleInputSchema>;

export const cancelPosSaleOutputSchema = z.object({
  cancelled: z.literal(true),
});

export type CancelPosSaleOutput = z.infer<typeof cancelPosSaleOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type CancelPosSaleDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /** Required: every step here degrades rather than throwing. */
  reportError?: ReporterPort;
};

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Voids an in-flight POS sale — the operator's "never mind".
 *
 * This is NOT `cancelPosReaderAction`. That clears the prompt on the reader and
 * deliberately leaves the order PENDING so the same cart can be re-dispatched.
 * This ends the sale: the order is cancelled, its PaymentIntent is cancelled,
 * and the stock it was holding is released.
 *
 * It exists because a PENDING order reserves capacity purely by being young
 * (see `assertTicketTypeCapacity`), and that window is sized to how long the
 * PaymentIntent stays confirmable — twenty minutes. Without an explicit void, a
 * buyer who walks away mid-tap freezes their tickets for that whole window,
 * with the expired-cart cron as the only release. On a small room with a queue
 * that is a real outage, and it is the common case, not an edge case.
 *
 * Order of operations mirrors `abandonFailedSale`: kill the CHARGE first, then
 * the order. A cancelled order with a live PaymentIntent is the dangerous
 * state — the webhook would find nothing to finalise and the buyer would be
 * charged for a sale that no longer exists. And "killed" means PROVEN dead:
 * the PaymentIntent's status is read back, because a card-present sale can be
 * paid at the reader in the same moment the operator hits cancel.
 *
 * The PI settle runs with no transaction open (two Stripe round-trips, 240s
 * worst case); the order cancel, the promo release and the seat release are
 * then one `repos.tx`, so a failure part-way leaves the sale exactly as it
 * was instead of a cancelled order with burnt codes and stranded seats.
 *
 * Auth: ORG_SCAN_ROLES on the event's org, derived from the ORDER, never from
 * client input.
 *
 * Idempotent by nature: cancelling an already-cancelled order is a no-op, and
 * a sale that has already succeeded is refused rather than unwound — a paid
 * order is a refund, not a cancellation.
 */
export async function cancelPosSale(
  deps: CancelPosSaleDeps,
  rawInput: unknown,
): Promise<CancelPosSaleOutput> {
  const input = parseInput(cancelPosSaleInputSchema, rawInput);

  const order = await deps.repos.orders.getById(input.orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }
  if (order.paymentChannel !== "POS") {
    throw fail("NOT_A_POS_ORDER");
  }
  if (order.status !== "PENDING") {
    // SUCCEEDED is a refund's job; CANCELLED is already the desired end state
    // but returning success would hide a double-cancel bug from the caller.
    throw fail("ORDER_NOT_PENDING");
  }

  if (!order.eventId) {
    throw fail("EVENT_NOT_FOUND");
  }
  const event = await deps.repos.events.getById(order.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  if (!event.orgId) {
    throw fail("EVENT_NOT_ORG_OWNED");
  }

  await requireScannerAccessOnOrg({
    repos: deps.repos,
    authz: deps.authz,
    orgId: event.orgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_SCAN_ROLES,
    errorCode: "INSUFFICIENT_ROLE",
  });

  // Clear the reader prompt first so the buyer isn't staring at an amount for
  // a sale that is being voided. Best-effort: the reader may already be idle,
  // and a stuck prompt must not block releasing the stock.
  if (input.posReaderId) {
    const reader = await deps.repos.posReaders.getById({
      id: input.posReaderId,
    });
    if (reader && reader.orgId === event.orgId) {
      await deps.payments
        .cancelReaderAction({ readerId: reader.stripeReaderId })
        .catch((err) => {
          deps.logger?.warn("pos.cancel_sale.reader_clear_failed", {
            orderId: order.id,
            posReaderId: reader.id,
            err,
          });
        });
    }
  }

  const { cancelled } = await voidPendingPosOrder(
    {
      repos: deps.repos,
      payments: deps.payments,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      id: order.id,
      stripePaymentIntentId: order.stripePaymentIntentId ?? null,
    },
    "cancelPosSale",
  );

  if (!cancelled) {
    // Lost a race with the finaliser or the reaper. The PI is already dead, so
    // the safe reading is "someone else ended this sale", not an error.
    deps.logger?.info("pos.cancel_sale.already_settled", { orderId: order.id });
    return cancelPosSaleOutputSchema.parse({ cancelled: true });
  }

  deps.logger?.info("pos.cancel_sale.success", {
    actorHumanId: input.actorHumanId,
    orgId: event.orgId,
    orderId: order.id,
  });
  deps.metrics?.increment("pos.cancel_sale.success", { eventId: event.id });

  return cancelPosSaleOutputSchema.parse({ cancelled: true });
}
