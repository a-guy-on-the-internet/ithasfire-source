import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the resale notices whose producers write the in-app row
// directly instead of through `notify` (resale/notify-resale-events.ts,
// resale/notify-resale-seller-sold.ts). Rendered by
// `direct-money-safety-renderers.ts`. Same rules as `./money.ts`: amounts and
// dates arrive already formatted, the event title is organizer text and stays
// verbatim.
//
// `eventTitle` is null when the event could not be read; English then says
// "your event" (as it always has), Spanish drops the "para …" phrase.
//
// The English strings are the producers' original text, byte for byte (the
// emails reuse some of them): never reword them here.
// ─────────────────────────────────────────────────────────────────────────────

type EventTitle = string | null;

export type ResaleListingCreatedCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: EventTitle; price: string }) => string;
  readonly viewListingLabel: string;
};

export const RESALE_LISTING_CREATED_COPY: {
  readonly [L in NotificationLocale]: ResaleListingCreatedCopy;
} = {
  en: {
    title: "Ticket listed for resale",
    body: ({ eventTitle, price }) =>
      `Your ticket for ${eventTitle ?? "your event"} is now listed at ${price}.`,
    viewListingLabel: "View listing",
  },
  es: {
    title: "Entrada publicada en reventa",
    body: ({ eventTitle, price }) =>
      eventTitle
        ? `Tu entrada para ${eventTitle} ya está en reventa a ${price}.`
        : `Tu entrada ya está en reventa a ${price}.`,
    viewListingLabel: "Ver anuncio",
  },
};

/** The claim kinds `createClaim` accepts (resale/create-claim.ts). */
export type ResaleClaimKind =
  | "ticket_invalid"
  | "entry_denied"
  | "wrong_seat"
  | "other";

export type ResaleClaimOpenedCopy = {
  readonly title: string;
  /**
   * `claimKind` is the raw stored kind; an unknown one reads as itself with
   * underscores turned into spaces (what English has always shown).
   */
  readonly body: (v: { eventTitle: EventTitle; claimKind: string }) => string;
  readonly viewClaimLabel: string;
};

function rawKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** Matches the web app's claim-kind labels (es.ts `pclKind*`), lowercased. */
const ES_CLAIM_KIND: { readonly [K in ResaleClaimKind]: string } = {
  ticket_invalid: "entrada no válida",
  entry_denied: "acceso denegado",
  wrong_seat: "asiento incorrecto",
  other: "otro motivo",
};

function esClaimKind(kind: string): string {
  return Object.prototype.hasOwnProperty.call(ES_CLAIM_KIND, kind)
    ? ES_CLAIM_KIND[kind as ResaleClaimKind]
    : rawKindLabel(kind);
}

export const RESALE_CLAIM_OPENED_COPY: {
  readonly [L in NotificationLocale]: ResaleClaimOpenedCopy;
} = {
  en: {
    title: "Claim filed against your sale",
    // No reply deadline (owner rulings Q8 + Q9, 2026-10-06): the seller may
    // reply until staff decide, and staff may decide at any time.
    body: ({ eventTitle, claimKind }) =>
      `A buyer has filed a "${rawKindLabel(claimKind)}" claim on your resale ticket for ${eventTitle ?? "your event"}. Reply with your side as soon as you can: support can decide the claim at any time.`,
    viewClaimLabel: "View claim",
  },
  es: {
    title: "Presentaron una reclamación sobre tu venta",
    body: ({ eventTitle, claimKind }) =>
      `Quien compró tu entrada de reventa${
        eventTitle ? ` para ${eventTitle}` : ""
      } presentó una reclamación por «${esClaimKind(claimKind)}». Responde con tu versión lo antes posible: el equipo de soporte puede resolver la reclamación en cualquier momento.`,
    viewClaimLabel: "Ver reclamación",
  },
};

export type ResaleClaimStatus = "approved" | "denied";

export type ResaleClaimResolvedCopy = {
  readonly buyer: {
    readonly title: (status: ResaleClaimStatus) => string;
    readonly body: (v: {
      eventTitle: EventTitle;
      status: ResaleClaimStatus;
      /**
       * Still carried by callers and stored rows, but no longer read: an
       * approved claim is always a full refund (owner ruling Q5, 2026-10-06).
       */
      resolution: string | null;
    }) => string;
    readonly label: string;
  };
  readonly seller: {
    readonly title: (status: ResaleClaimStatus) => string;
    readonly body: (v: {
      eventTitle: EventTitle;
      status: ResaleClaimStatus;
    }) => string;
    readonly label: string;
  };
};

export const RESALE_CLAIM_RESOLVED_COPY: {
  readonly [L in NotificationLocale]: ResaleClaimResolvedCopy;
} = {
  en: {
    buyer: {
      title: (status) =>
        status === "approved"
          ? "Your claim has been approved"
          : "Your claim has been denied",
      body: ({ eventTitle, status }) => {
        const title = eventTitle ?? "your event";
        if (status !== "approved") {
          return `Your claim for the ${title} resale ticket has been denied. See the claim details for more information.`;
        }
        return `Your claim for the ${title} resale ticket has been approved. A full refund will be processed.`;
      },
      label: "View claim",
    },
    seller: {
      title: (status) =>
        status === "approved"
          ? "Claim resolved — refund issued"
          : "Claim resolved in your favor",
      body: ({ eventTitle, status }) => {
        const title = eventTitle ?? "your event";
        return status === "approved"
          ? `A claim on your resale ticket for ${title} has been resolved in the buyer's favor. The payout for this sale has been adjusted accordingly.`
          : `A claim on your resale ticket for ${title} has been resolved in your favor. The money from this sale is no longer on hold and will be paid out as usual.`;
      },
      label: "View details",
    },
  },
  es: {
    buyer: {
      title: (status) =>
        status === "approved"
          ? "Tu reclamación fue aprobada"
          : "Tu reclamación no fue aprobada",
      body: ({ eventTitle, status }) => {
        const ticket = `la entrada de reventa${eventTitle ? ` para ${eventTitle}` : ""}`;
        if (status !== "approved") {
          return `Tu reclamación sobre ${ticket} no fue aprobada. Consulta los detalles de la reclamación para más información.`;
        }
        return `Tu reclamación sobre ${ticket} fue aprobada. Se procesará un reembolso completo.`;
      },
      label: "Ver reclamación",
    },
    seller: {
      title: (status) =>
        status === "approved"
          ? "Reclamación resuelta: se emitió un reembolso"
          : "Reclamación resuelta a tu favor",
      body: ({ eventTitle, status }) => {
        const ticket = `tu entrada de reventa${eventTitle ? ` para ${eventTitle}` : ""}`;
        return status === "approved"
          ? `Una reclamación sobre ${ticket} se resolvió a favor de quien compró. El pago de esta venta se ajustó en consecuencia.`
          : `Una reclamación sobre ${ticket} se resolvió a tu favor. El dinero de esta venta ya no está retenido y se pagará como de costumbre.`;
      },
      label: "Ver detalles",
    },
  },
};

export type ResaleSellerSoldCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: EventTitle; amount: string }) => string;
  readonly viewDetailsLabel: string;
};

export const RESALE_SELLER_SOLD_COPY: {
  readonly [L in NotificationLocale]: ResaleSellerSoldCopy;
} = {
  en: {
    title: "Ticket sold!",
    body: ({ eventTitle, amount }) =>
      `Your ticket for ${eventTitle ?? "your event"} sold for ${amount}. Payout will be processed after the event.`,
    viewDetailsLabel: "View details",
  },
  es: {
    title: "¡Vendiste tu entrada!",
    body: ({ eventTitle, amount }) =>
      `Tu entrada${eventTitle ? ` para ${eventTitle}` : ""} se vendió por ${amount}. El pago se procesará después del evento.`,
    viewDetailsLabel: "Ver detalles",
  },
};

/**
 * Seller-facing: a listing made under the markup split was closed when the
 * split was removed (organiser-resale-share FR-015), and the seller may list
 * again under the share. Written by `cancelLegacyResaleListings`
 * (resale/cancel-legacy-resale-listings.ts), in-app and email.
 */
export type ResaleListingClosedRelistCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: EventTitle; price: string }) => string;
  readonly listAgainLabel: string;
  readonly emailSubject: (v: { eventTitle: EventTitle }) => string;
  readonly emailLink: (url: string) => string;
  readonly emailSignoff: string;
};

export const RESALE_LISTING_CLOSED_RELIST_COPY: {
  readonly [L in NotificationLocale]: ResaleListingClosedRelistCopy;
} = {
  en: {
    title: "Your resale listing was closed",
    body: ({ eventTitle, price }) =>
      `We closed your listing for ${eventTitle ?? "your event"} at ${price}. Every resale now pays a share to the people who put on the night, and your listing was made before that change. Your ticket is yours again: list it again to sell it.`,
    listAgainLabel: "List it again",
    emailSubject: ({ eventTitle }) =>
      eventTitle
        ? `Your resale listing for ${eventTitle} was closed`
        : "Your resale listing was closed",
    emailLink: (url) => `List it again: ${url}`,
    emailSignoff: "Ithas Fire Support",
  },
  es: {
    title: "Cerramos tu anuncio de reventa",
    body: ({ eventTitle, price }) =>
      `Cerramos tu anuncio${eventTitle ? ` para ${eventTitle}` : ""} por ${price}. Ahora cada reventa paga una parte a quienes organizan el evento, y tu anuncio se publicó antes de ese cambio. Tu entrada vuelve a ser tuya: publícala de nuevo para venderla.`,
    listAgainLabel: "Publicar de nuevo",
    emailSubject: ({ eventTitle }) =>
      eventTitle
        ? `Cerramos tu anuncio de reventa para ${eventTitle}`
        : "Cerramos tu anuncio de reventa",
    emailLink: (url) => `Publícala de nuevo: ${url}`,
    emailSignoff: "Soporte de Ithas Fire",
  },
};

/**
 * Seller-facing: a resale sale was refunded to the buyer, and the seller's
 * listing, made under the removed markup split, was closed instead of going
 * back on sale (organiser-resale-share FR-015). Says plainly that the sale's
 * payout will not happen. Written after the refund commits, in-app only,
 * from `sendLegacyRelistNotices` (resale/_shared/send-legacy-relist-notices.ts).
 */
export type ResaleSaleRefundedListingClosedCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: EventTitle; price: string }) => string;
  readonly listAgainLabel: string;
};

export const RESALE_SALE_REFUNDED_LISTING_CLOSED_COPY: {
  readonly [L in NotificationLocale]: ResaleSaleRefundedListingClosedCopy;
} = {
  en: {
    title: "Your resale was refunded",
    body: ({ eventTitle, price }) =>
      `Your ticket for ${eventTitle ?? "your event"} sold for ${price}, and the buyer has been refunded, so you won't be paid for that sale. Your listing was made before every resale paid a share to the people who put on the night, so we closed it instead of putting it back on sale. Your ticket is yours again: list it again to sell it.`,
    listAgainLabel: "List it again",
  },
  es: {
    title: "Se reembolsó tu reventa",
    body: ({ eventTitle, price }) =>
      `Tu entrada${eventTitle ? ` para ${eventTitle}` : ""} se vendió por ${price} y le devolvimos el dinero a quien la compró, así que no recibirás el pago de esa venta. Tu anuncio se publicó antes de que cada reventa pagara una parte a quienes organizan el evento, así que lo cerramos en vez de volver a ponerlo a la venta. Tu entrada vuelve a ser tuya: publícala de nuevo para venderla.`,
    listAgainLabel: "Publicar de nuevo",
  },
};

/**
 * Buyer-facing: the refund for an APPROVED claim has been issued and the order
 * is REFUNDED. `charge.refunded` can arrive while Stripe still lists the refund
 * as pending, so the words say "we've refunded you", never that the money has
 * arrived. Owner 2026-10-07: "it'll
 * be nice for them to know that they have been refunded." Written by
 * resale/notify-claim-refunded.ts, in-app AND email; the email is rendered in
 * the buyer's stored locale (Human.locale), so it carries its own copy here
 * rather than reusing the English in-app text like the older claim emails.
 *
 * No date is promised: the bank decides when the money shows.
 */
export type ResaleClaimRefundedCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: EventTitle; amount: string }) => string;
  readonly viewOrderLabel: string;
  readonly emailSubject: (v: { eventTitle: EventTitle }) => string;
  readonly emailLink: (url: string) => string;
  readonly emailSignoff: string;
};

export const RESALE_CLAIM_REFUNDED_COPY: {
  readonly [L in NotificationLocale]: ResaleClaimRefundedCopy;
} = {
  en: {
    title: "We've refunded you",
    body: ({ eventTitle, amount }) =>
      `We refunded ${amount} for ${
        eventTitle ? `the ${eventTitle} resale ticket` : "your resale ticket"
      } to the payment method you used. Your bank can take 5 to 10 business days to show it.`,
    viewOrderLabel: "View order",
    emailSubject: ({ eventTitle }) =>
      eventTitle
        ? `We've refunded you for ${eventTitle}`
        : "We've refunded you",
    emailLink: (url) => `View your order: ${url}`,
    emailSignoff: "Ithas Fire Support",
  },
  es: {
    title: "Te reembolsamos",
    body: ({ eventTitle, amount }) =>
      `Te devolvimos ${amount} por la entrada de reventa${
        eventTitle ? ` para ${eventTitle}` : ""
      } al mismo medio de pago que usaste. Tu banco puede tardar de 5 a 10 días hábiles en mostrarlo.`,
    viewOrderLabel: "Ver pedido",
    emailSubject: ({ eventTitle }) =>
      eventTitle
        ? `Te reembolsamos por ${eventTitle}`
        : "Te reembolsamos",
    emailLink: (url) => `Ver tu pedido: ${url}`,
    emailSignoff: "Soporte de Ithas Fire",
  },
};
