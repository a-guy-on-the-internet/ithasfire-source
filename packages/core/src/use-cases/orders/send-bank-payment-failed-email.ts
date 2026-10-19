import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { formatOrderCode } from "@th/types/order-identifier";

import { eventPublicUrl } from "../../lib/public-urls";

// ── Types ──────────────────────────────────────────────────────────────────

export type SendBankPaymentFailedEmailDeps = {
  repos: Pick<Repos, "orders" | "humans" | "events">;
  mailer: MailerPort;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

export type SendBankPaymentFailedEmailParams = {
  orderId: string;
  /** Public web base URL; the "buy again" button links the event page under it. */
  publicAppUrl: string;
};

const USE_CASE = "orders.sendBankPaymentFailedEmail";

/**
 * Tells the buyer their bank (ACH) payment failed and the order was cancelled.
 *
 * Called by the `payment_intent.payment_failed` webhook ONLY after it won the
 * PROCESSING → CANCELLED CAS. That CAS wins once per order, which is what keeps
 * this at-most-once across Stripe redeliveries; the mailer idempotency key is
 * a second fence for a send that is retried.
 *
 * Works for primary and resale orders alike: both are TICKETING orders with an
 * event and a buyer.
 *
 * Best-effort: it never throws. Every failure (missing order, buyer or event,
 * a mailer error) is logged at error level and handed to `reportError`.
 */
export async function sendBankPaymentFailedEmail(
  deps: SendBankPaymentFailedEmailDeps,
  params: SendBankPaymentFailedEmailParams,
): Promise<void> {
  const logger = deps.logger?.child({ notify: "bank_payment_failed_email" });

  const report = (
    err: unknown,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    logger?.error("notify.bank_payment_failed_email.failed", {
      reason,
      orderId: params.orderId,
      error: err instanceof Error ? err.message : String(err),
      ...extra,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: USE_CASE, reason },
        extra: { orderId: params.orderId, ...extra },
      });
    } catch {
      // A throwing reporter must never change the (swallowed) outcome.
    }
  };

  try {
    const order = await deps.repos.orders.getById(params.orderId);
    if (!order) {
      report(new Error("order_not_found"), "order_not_found");
      return;
    }
    if (order.kind !== "TICKETING" || !order.eventId) {
      report(new Error("not_a_ticketing_order"), "not_a_ticketing_order", {
        kind: order.kind,
      });
      return;
    }

    const buyer = await deps.repos.humans.getByIdWithIdentity(
      order.buyerHumanId,
    );
    if (!buyer?.identity.email) {
      report(new Error("buyer_not_found"), "buyer_not_found", {
        buyerHumanId: order.buyerHumanId,
      });
      return;
    }

    const event = await deps.repos.events.getById(order.eventId);
    if (!event) {
      report(new Error("event_not_found"), "event_not_found", {
        eventId: order.eventId,
      });
      return;
    }

    const sent = await deps.mailer.send({
      to: { to: buyer.identity.email },
      template: {
        key: "order.bank_payment_failed",
        variables: {
          eventTitle: event.title,
          // DISPLAYED code only: the 8-hex TAIL, uppercased, as everywhere else.
          orderCode: formatOrderCode(order.id),
          eventUrl: eventPublicUrl({
            baseUrl: params.publicAppUrl,
            slug: event.slug,
          }),
        },
      },
      idempotencyKey: `bank-payment-failed:${order.id}`,
    });

    // The mailer can decline without throwing (a suppressed recipient, a test
    // domain): an expected outcome, not a fault, so info and no Sentry.
    if (sent?.result?.success === false) {
      logger?.info("notify.bank_payment_failed_email.skipped", {
        orderId: order.id,
        errorCode: sent.result.errorCode,
      });
      return;
    }

    logger?.info("notify.bank_payment_failed_email.sent", {
      orderId: order.id,
      source: order.source,
    });
  } catch (err) {
    report(err, "send_failed");
  }
}
