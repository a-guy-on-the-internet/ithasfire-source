import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// Copy for the frozen-deal change notice (freeze-the-deal FR-006,
// `deal.frozen-change`), one entry per `NotificationLocale` (pattern:
// ./money.ts). The email is written in the recipient's stored language
// (`emailLocale` in the payload), the in-app row in the reader's.
//
// Each changed line reads "<what>: <before> → <after>". Amounts arrive
// formatted by `formatCents` (money formatting is not localized). Names
// (payees, the person who made the change, cost labels) are verbatim.
//
// Spanish vocabulary: "acuerdo" the deal, "congelado" frozen, "parte" a share,
// "costos" costs off the top, "reventa" a resale, "pago(s)" payouts.
// ─────────────────────────────────────────────────────────────────────────────

export type DealChangeBasis = "GROSS" | "NET_POOL";
export type DealChangeSchedule =
  | "ASAP"
  | "WEEK_OF_EVENT"
  | "ONE_WEEK_AFTER"
  | "TWO_WEEKS_AFTER"
  | "FOUR_WEEKS_AFTER";

export type DealChangeCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  /** `actorName` null = the person's account is gone. */
  readonly body: (v: {
    actorName: string | null;
    eventTitle: string;
    changeCount: number;
  }) => string;
  /** "and 3 more changes" after a shortened list. */
  readonly more: (count: number) => string;
  /** When the change has no line a person can read (only ordering moved). */
  readonly noVisibleLines: string;
  readonly sections: { readonly TICKETS: string; readonly RESALE: string; readonly BOOKING: string };
  readonly schedulePrefix: string;
  readonly resaleSharePrefix: string;
  readonly guaranteePrefix: string;
  /** "Sound costs (credited to Paper Moth)". */
  readonly cost: (v: { label: string; payeeName: string }) => string;
  readonly percentOf: (v: { percent: string; basis: DealChangeBasis }) => string;
  readonly fixedPlusPercent: (v: { fixed: string; percentOf: string }) => string;
  readonly fixedVersusPercent: (v: { fixed: string; percentOf: string }) => string;
  readonly capped: (v: { value: string; capPercent: number }) => string;
  readonly schedule: (s: DealChangeSchedule) => string;
  readonly resaleShare: (v: { amount: string; payer: "SELLER" | "BUYER" }) => string;
  readonly notOnDeal: string;
  readonly removed: string;
  readonly someone: string;
  readonly unnamedPayee: string;
  readonly viewDealLabel: string;
  /** Email: who made the change and when (`when` null = unknown). */
  readonly changedBy: (v: { actorName: string; when: string | null }) => string;
  /** Email footer for a payee still on the deal after the change. */
  readonly footerOnDeal: string;
  /** Email footer for a payee the change took off the deal. */
  readonly footerWasOnDeal: string;
};

export const DEAL_CHANGE_COPY: {
  readonly [L in NotificationLocale]: DealChangeCopy;
} = {
  en: {
    title: ({ eventTitle }) => `The deal for ${eventTitle} changed`,
    body: ({ actorName, eventTitle, changeCount }) =>
      `${actorName ?? "Someone"} changed the frozen deal for ${eventTitle}: ${changeCount} ${
        changeCount === 1 ? "line" : "lines"
      } changed.`,
    more: (count) => `And ${count} more ${count === 1 ? "change" : "changes"}.`,
    noVisibleLines: "The order of the lines changed; what each payee gets did not.",
    sections: { TICKETS: "Ticket sales", RESALE: "Resales", BOOKING: "Booking" },
    schedulePrefix: "Payout schedule",
    resaleSharePrefix: "Resale share",
    guaranteePrefix: "Guarantee",
    cost: ({ label, payeeName }) => `${label} (credited to ${payeeName})`,
    percentOf: ({ percent, basis }) =>
      basis === "GROSS" ? `${percent} of ticket money` : `${percent} of what's left after costs`,
    fixedPlusPercent: ({ fixed, percentOf }) => `${fixed} plus ${percentOf}`,
    fixedVersusPercent: ({ fixed, percentOf }) =>
      `${fixed} or ${percentOf}, whichever is more`,
    capped: ({ value, capPercent }) => `${value}, capped at ${capPercent}%`,
    schedule: (s) =>
      ({
        ASAP: "as soon as possible",
        WEEK_OF_EVENT: "the week of the event",
        ONE_WEEK_AFTER: "one week after the event",
        TWO_WEEKS_AFTER: "two weeks after the event",
        FOUR_WEEKS_AFTER: "four weeks after the event",
      })[s],
    resaleShare: ({ amount, payer }) =>
      payer === "BUYER"
        ? `${amount} of each resale, paid by the buyer on top`
        : `${amount} of each resale, paid by the seller`,
    notOnDeal: "not on the deal",
    removed: "removed",
    someone: "Someone",
    unnamedPayee: "A payee",
    viewDealLabel: "View the deal",
    changedBy: ({ actorName, when }) => `Changed by ${actorName}${when ? `, ${when}` : ""}.`,
    footerOnDeal:
      "You get this because you are on this deal. Everyone on the deal gets this email.",
    footerWasOnDeal:
      "You get this because you were on this deal before this change. Everyone who was on the deal or is on it now gets this email.",
  },
  es: {
    title: ({ eventTitle }) => `Cambió el acuerdo de ${eventTitle}`,
    body: ({ actorName, eventTitle, changeCount }) =>
      `${actorName ?? "Alguien"} cambió el acuerdo congelado de ${eventTitle}: ${changeCount} ${
        changeCount === 1 ? "línea cambió" : "líneas cambiaron"
      }.`,
    more: (count) => `Y ${count} ${count === 1 ? "cambio más" : "cambios más"}.`,
    noVisibleLines: "Cambió el orden de las líneas; lo que recibe cada quien no cambió.",
    sections: { TICKETS: "Venta de entradas", RESALE: "Reventas", BOOKING: "Contratación" },
    schedulePrefix: "Calendario de pagos",
    resaleSharePrefix: "Parte de la reventa",
    guaranteePrefix: "Garantía",
    cost: ({ label, payeeName }) => `${label} (se acredita a ${payeeName})`,
    percentOf: ({ percent, basis }) =>
      basis === "GROSS"
        ? `${percent} del dinero de las entradas`
        : `${percent} de lo que queda tras los costos`,
    fixedPlusPercent: ({ fixed, percentOf }) => `${fixed} más ${percentOf}`,
    fixedVersusPercent: ({ fixed, percentOf }) =>
      `${fixed} o ${percentOf}, lo que sea mayor`,
    capped: ({ value, capPercent }) => `${value}, con un tope del ${capPercent}%`,
    schedule: (s) =>
      ({
        ASAP: "lo antes posible",
        WEEK_OF_EVENT: "la semana del evento",
        ONE_WEEK_AFTER: "una semana después del evento",
        TWO_WEEKS_AFTER: "dos semanas después del evento",
        FOUR_WEEKS_AFTER: "cuatro semanas después del evento",
      })[s],
    resaleShare: ({ amount, payer }) =>
      payer === "BUYER"
        ? `${amount} de cada reventa, que paga quien compra además del precio`
        : `${amount} de cada reventa, que paga quien vende`,
    notOnDeal: "no estaba en el acuerdo",
    removed: "quitada",
    someone: "Alguien",
    unnamedPayee: "Una persona del acuerdo",
    viewDealLabel: "Ver el acuerdo",
    changedBy: ({ actorName, when }) => `Cambio hecho por ${actorName}${when ? `, ${when}` : ""}.`,
    footerOnDeal:
      "Te llega porque estás en este acuerdo. Todas las personas del acuerdo reciben este correo.",
    footerWasOnDeal:
      "Te llega porque estabas en este acuerdo antes de este cambio. Todas las personas que estaban o están en el acuerdo reciben este correo.",
  },
};
