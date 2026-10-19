import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { formatOrderCode } from "@th/types/order-identifier";

import { getMetaString } from "../../lib/orders/meta";
import { trimTrailingSlash } from "../../lib/url";
import { requireTicketingEventId } from "../orders/_shared/require-ticketing-order";

// ── Types ──────────────────────────────────────────────────────────────────

export type SendResalePurchaseEmailDeps = {
  repos: Repos;
  mailer: MailerPort;
  logger?: LoggerPort;
};

export type SendResalePurchaseEmailParams = {
  orderId: string;
  publicAppUrl: string;
  supportUrl: string;
  tileServerUrl?: string;
};

/**
 * Sends a purchase confirmation email to the resale buyer.
 *
 * Unlike `sendTicketIssuedEmail` (which renders QR codes for freshly-minted
 * tickets), this uses the `order.receipt` template to confirm the resale
 * purchase. The buyer's ticket has already been reassigned and new QR codes
 * generated inside `finalizeResalePurchase`.
 *
 * This is a fire-and-forget notification — failures are logged, never thrown.
 */
export async function sendResalePurchaseEmail(
  deps: SendResalePurchaseEmailDeps,
  params: SendResalePurchaseEmailParams,
): Promise<void> {
  const logger = deps.logger?.child({ notify: "resale_purchase_email" });

  try {
    // ── Load order ──────────────────────────────────────────────────────
    const order = await deps.repos.orders.getById(params.orderId);
    if (!order) {
      logger?.warn("notify.resale_purchase_email.order_not_found", {
        orderId: params.orderId,
      });
      return;
    }

    // ── Load buyer identity (for email address) ─────────────────────────
    const buyerWithIdentity = await deps.repos.humans.getByIdWithIdentity(
      order.buyerHumanId,
    );
    if (!buyerWithIdentity) {
      logger?.warn("notify.resale_purchase_email.buyer_not_found", {
        buyerHumanId: order.buyerHumanId,
      });
      return;
    }
    const { identity } = buyerWithIdentity;

    // ── Load event for title ────────────────────────────────────────────
    const event = await deps.repos.events.getById(requireTicketingEventId(order));
    if (!event) {
      logger?.warn("notify.resale_purchase_email.event_not_found", {
        eventId: order.eventId,
      });
      return;
    }

    // ── Build line items from order items ────────────────────────────────
    const lineItems = order.items.map((item) => {
      const ticketTypeName = getMetaString(item.meta, "ticketTypeName");
      return {
        label:
          item.kind === "ticket"
            ? `Resale Ticket${ticketTypeName ? ` — ${ticketTypeName}` : ""}`
            : item.kind === "surcharge"
              ? "Service Fee"
              : item.kind,
        amountCents: item.amountCents,
      };
    });

    const totalCents = lineItems.reduce((sum, li) => sum + li.amountCents, 0);

    const publicAppUrl = trimTrailingSlash(params.publicAppUrl);
    const viewOrderUrl = `${publicAppUrl}/orders/${order.id}`;

    // ── Send via order.receipt template ──────────────────────────────────
    await deps.mailer.send({
      to: { to: identity.email },
      template: {
        key: "order.receipt",
        variables: {
          // DISPLAYED value only — the ONE order code (`formatOrderCode`: the
          // 8-hex TAIL, uppercased), the same string the resale confirmation
          // screen and admin search show. `viewOrderUrl` below keeps the RAW
          // UUID (it is a path segment), as do the idempotency key and the
          // log fields.
          orderId: formatOrderCode(order.id),
          buyerName:
            buyerWithIdentity.human?.name ??
            identity.email.split("@")[0] ??
            "there",
          lineItems,
          totalCents,
          eventTitle: event.title,
          viewOrderUrl,
        },
      },
      idempotencyKey: `resale-purchase-receipt:${order.id}`,
    });

    logger?.info("notify.resale_purchase_email.sent", {
      orderId: order.id,
      recipientEmail: identity.email,
    });
  } catch (err) {
    logger?.warn("notify.resale_purchase_email.failed", {
      error: err instanceof Error ? err.message : String(err),
      orderId: params.orderId,
    });
  }
}
