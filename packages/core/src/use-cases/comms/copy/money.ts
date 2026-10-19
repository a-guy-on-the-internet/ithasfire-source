import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the money notices (payout, order, refund, resale purchase).
// Same rules as `./rsvp.ts`. Amounts arrive already formatted by `formatCents`
// (money formatting is unchanged: no localized symbols or separators).
//
// Spanish vocabulary, used consistently:
//   - "pago" for a payout (the money), "transferencia bancaria" only for the
//     bank transfer the copy says was NOT sent: so the two words never blur;
//   - "pedido" order, "reembolso" refund, "entradas" tickets, "reventa" resale,
//     "venta(s)" sales, "reserva" the rolling reserve.
// ─────────────────────────────────────────────────────────────────────────────

export type PayoutKind = "payout" | "applied_to_balance" | "reserved";

export type PayoutCompletedCopy = {
  readonly title: (kind: PayoutKind) => string;
  /** `amount` is formatted money; `salesCount` is the number of sales. */
  readonly body: (v: {
    kind: PayoutKind;
    amount: string;
    salesCount: number;
  }) => string;
  readonly viewPayoutsLabel: string;
};

export const PAYOUT_COMPLETED_COPY: {
  readonly [L in NotificationLocale]: PayoutCompletedCopy;
} = {
  en: {
    title: (kind) =>
      kind === "applied_to_balance"
        ? "Payout applied to your outstanding balance"
        : kind === "reserved"
          ? "Payout held in reserve"
          : "You've been paid",
    body: ({ kind, amount, salesCount }) => {
      const summary = `${salesCount} ${salesCount === 1 ? "sale" : "sales"}`;
      return kind === "applied_to_balance"
        ? `${amount} from ${summary} was applied to your outstanding balance from a lost dispute. No bank transfer was sent.`
        : kind === "reserved"
          ? `${amount} from ${summary} is being held in reserve and will be released with a future payout. No bank transfer was sent.`
          : `${amount} from ${summary} was sent to your Stripe account.`;
    },
    viewPayoutsLabel: "View payouts",
  },
  es: {
    title: (kind) =>
      kind === "applied_to_balance"
        ? "Pago aplicado a tu saldo pendiente"
        : kind === "reserved"
          ? "Pago retenido como reserva"
          : "Pago enviado",
    body: ({ kind, amount, salesCount }) => {
      const summary = `${salesCount} ${salesCount === 1 ? "venta" : "ventas"}`;
      return kind === "applied_to_balance"
        ? `Usamos ${amount} de ${summary} para cubrir tu saldo pendiente por una disputa perdida. No se envió ninguna transferencia bancaria.`
        : kind === "reserved"
          ? `Retuvimos ${amount} de ${summary} como reserva; se liberará en un pago futuro. No se envió ninguna transferencia bancaria.`
          : `Enviamos ${amount} de ${summary} a tu cuenta de Stripe.`;
    },
    viewPayoutsLabel: "Ver pagos",
  },
};

export type OrderConfirmedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: {
    eventTitle: string;
    ticketCount: number;
    amount: string;
  }) => string;
  readonly viewTicketsLabel: string;
};

export const ORDER_CONFIRMED_COPY: {
  readonly [L in NotificationLocale]: OrderConfirmedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're going to ${eventTitle}!`,
    body: ({ eventTitle, ticketCount, amount }) => {
      const single = ticketCount === 1;
      return `Your ${ticketCount} ${single ? "ticket" : "tickets"} for ${eventTitle} (${amount}) ${single ? "is" : "are"} confirmed and ready in your account.`;
    },
    viewTicketsLabel: "View tickets",
  },
  es: {
    title: ({ eventTitle }) => `¡Vas a ir a ${eventTitle}!`,
    body: ({ eventTitle, ticketCount, amount }) =>
      ticketCount === 1
        ? `Tu entrada para ${eventTitle} (${amount}) está confirmada y lista en tu cuenta.`
        : `Tus ${ticketCount} entradas para ${eventTitle} (${amount}) están confirmadas y listas en tu cuenta.`,
    viewTicketsLabel: "Ver entradas",
  },
};

export type OrderRefundProcessedCopy = {
  readonly title: (v: { partial: boolean }) => string;
  /** `eventTitle` null/empty = the order has no event to name. */
  readonly body: (v: {
    partial: boolean;
    amount: string;
    eventTitle: string | null | undefined;
  }) => string;
  readonly viewOrdersLabel: string;
};

export const ORDER_REFUND_PROCESSED_COPY: {
  readonly [L in NotificationLocale]: OrderRefundProcessedCopy;
} = {
  en: {
    title: ({ partial }) =>
      partial ? "Partial refund processed" : "Refund processed",
    body: ({ partial, amount, eventTitle }) => {
      const eventFragment = eventTitle ? ` for ${eventTitle}` : "";
      return partial
        ? `A partial refund of ${amount}${eventFragment} is on its way back to your original payment method.`
        : `Your refund of ${amount}${eventFragment} is on its way back to your original payment method.`;
    },
    viewOrdersLabel: "View orders",
  },
  es: {
    title: ({ partial }) =>
      partial ? "Reembolso parcial procesado" : "Reembolso procesado",
    body: ({ partial, amount, eventTitle }) => {
      const eventFragment = eventTitle ? ` por tu pedido para ${eventTitle}` : "";
      return `Tu ${partial ? "reembolso parcial" : "reembolso"} de ${amount}${eventFragment} ya va de camino a tu método de pago original.`;
    },
    viewOrdersLabel: "Ver pedidos",
  },
};

/**
 * The refund notice for a refund that moved NO money: every ticket returned
 * cost the buyer $0 (owner ruling 2026-10-11: such a ticket refunds $0). The
 * ticket is no longer valid, possibly by a staff action, so the buyer is
 * still told; "is on its way back to your payment method" would be false.
 * Rendered by `order.refund-processed` when `amountCents` is 0.
 */
export type OrderTicketReturnedCopy = {
  readonly title: (v: { ticketCount: number }) => string;
  /**
   * `eventTitle` null/empty = the order has no event to name. No amount: a
   * $0 refund can also be a paid ticket whose processing-fee share took its
   * whole refund, so the copy makes no claim about what the ticket cost.
   */
  readonly body: (v: {
    ticketCount: number;
    eventTitle: string | null | undefined;
  }) => string;
};

export const ORDER_TICKET_RETURNED_COPY: {
  readonly [L in NotificationLocale]: OrderTicketReturnedCopy;
} = {
  en: {
    title: ({ ticketCount }) =>
      ticketCount === 1 ? "Ticket returned" : "Tickets returned",
    body: ({ ticketCount, eventTitle }) => {
      const eventFragment = eventTitle ? ` for ${eventTitle}` : "";
      return ticketCount === 1
        ? `Your ticket${eventFragment} was returned. There is no money to refund for it.`
        : `Your tickets${eventFragment} were returned. There is no money to refund for them.`;
    },
  },
  es: {
    title: ({ ticketCount }) =>
      ticketCount === 1 ? "Entrada devuelta" : "Entradas devueltas",
    body: ({ ticketCount, eventTitle }) => {
      const eventFragment = eventTitle ? ` para ${eventTitle}` : "";
      return ticketCount === 1
        ? `Tu entrada${eventFragment} fue devuelta. No hay dinero que reembolsar por ella.`
        : `Tus entradas${eventFragment} fueron devueltas. No hay dinero que reembolsar por ellas.`;
    },
  },
};

export type ResalePurchaseConfirmedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: { eventTitle: string; amount: string }) => string;
  readonly viewTicketLabel: string;
};

export const RESALE_PURCHASE_CONFIRMED_COPY: {
  readonly [L in NotificationLocale]: ResalePurchaseConfirmedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're going to ${eventTitle}!`,
    body: ({ eventTitle, amount }) =>
      `Your resale ticket for ${eventTitle} (${amount}) is confirmed. We've issued a fresh QR code — find it in your account.`,
    viewTicketLabel: "View ticket",
  },
  es: {
    title: ({ eventTitle }) => `¡Vas a ir a ${eventTitle}!`,
    body: ({ eventTitle, amount }) =>
      `Tu entrada de reventa para ${eventTitle} (${amount}) está confirmada. Generamos un código QR nuevo; lo encontrarás en tu cuenta.`,
    viewTicketLabel: "Ver entrada",
  },
};
