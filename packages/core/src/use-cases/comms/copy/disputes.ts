import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the dispute notice a payee's risk owners get
// (disputes/notify-dispute-lifecycle.ts writes the row directly; rendered by
// `direct-money-safety-renderers.ts`). The email reuses the English body, so
// the English strings are the producer's original text, byte for byte: never
// reword them here.
//
// The copy follows what the ledger pass DID (see the comments in
// `buildRiskOwnerCopy`): `LostOutcome` names each branch, so a translation can
// never claim a deduction the English does not.
//
// Spanish vocabulary: "disputa" dispute, "pago(s)" payout(s) (as in
// ./money.ts), "parte del pago" payout share, "monto en disputa" disputed
// amount, "comisión por disputa de la red de tarjetas" the card network's
// dispute fee, "membresía" membership.
// ─────────────────────────────────────────────────────────────────────────────

export type DisputeNotice =
  | "opened"
  | "under_review"
  | "funds_withdrawn"
  | "won"
  | "lost";

/** What a LOST pass did, per product line (null on every other notice). */
export type DisputeLostOutcome =
  | "ticketing_debited"
  | "ticketing_not_debited"
  | "membership_debited"
  | "membership_debited_with_fee"
  | "membership_fee_debited"
  | "membership_not_debited";

export type DisputeRiskOwnerCopy = {
  /**
   * What the dispute is about: the event title (verbatim), else the
   * membership / event fallback.
   */
  readonly subject: (v: { eventTitle: string | null; isMembership: boolean }) => string;
  readonly title: (notice: DisputeNotice) => string;
  /** `evidenceDue` is the formatted date, or null when Stripe gave none. */
  readonly body: (v: {
    notice: DisputeNotice;
    subject: string;
    evidenceDue: string | null;
    lostOutcome: DisputeLostOutcome | null;
  }) => string;
};

export const DISPUTE_RISK_OWNER_COPY: {
  readonly [L in NotificationLocale]: DisputeRiskOwnerCopy;
} = {
  en: {
    subject: ({ eventTitle, isMembership }) =>
      eventTitle ?? (isMembership ? "your membership" : "your event"),
    title: (notice) => {
      switch (notice) {
        case "opened":
          return "Dispute opened";
        case "under_review":
          return "Dispute under review";
        case "funds_withdrawn":
          return "Dispute funds withdrawn";
        case "won":
          return "Dispute won";
        case "lost":
          return "Dispute lost";
      }
    },
    body: ({ notice, subject, evidenceDue, lostOutcome }) => {
      switch (notice) {
        case "opened":
          return `A buyer dispute was opened for ${subject}. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due ${evidenceDue ?? "not provided"}.`;
        case "under_review":
          return `The buyer dispute for ${subject} is under review. The affected payout share remains held while the bank reviews the dispute.`;
        case "funds_withdrawn":
          return `Stripe has withdrawn funds for the dispute on ${subject}. The affected payout share remains held while the bank reviews the dispute.`;
        case "won":
          return `The dispute for ${subject} was won. Nothing will be deducted from your payouts for it. Any hold on the affected payout share has been released, and any amount already deducted for this dispute has been credited back.`;
        case "lost": {
          const lost = `The dispute for ${subject} was lost.`;
          switch (lostOutcome ?? "ticketing_debited") {
            case "membership_debited_with_fee":
              return `${lost} The disputed amount plus the card network's dispute fee will be deducted from your upcoming payouts.`;
            case "membership_debited":
              return `${lost} The disputed amount will be deducted from your upcoming payouts.`;
            case "membership_fee_debited":
              return `${lost} Nothing further will be deducted from your payouts for the disputed amount. The card network's dispute fee will be deducted from your upcoming payouts.`;
            case "membership_not_debited":
              return `${lost} Nothing further will be deducted from your payouts for the disputed amount.`;
            case "ticketing_not_debited":
              return `${lost} Nothing further will be deducted from your payouts for this dispute. The card network's dispute fee is not passed on to you.`;
            case "ticketing_debited":
              return `${lost} The disputed amount will be deducted from your upcoming payouts. The card network's dispute fee is not passed on to you.`;
          }
        }
      }
    },
  },
  es: {
    subject: ({ eventTitle, isMembership }) =>
      eventTitle ?? (isMembership ? "tu membresía" : "tu evento"),
    title: (notice) => {
      switch (notice) {
        case "opened":
          return "Se abrió una disputa";
        case "under_review":
          return "Disputa en revisión";
        case "funds_withdrawn":
          return "Fondos retirados por una disputa";
        case "won":
          return "Disputa ganada";
        case "lost":
          return "Disputa perdida";
      }
    },
    body: ({ notice, subject, evidenceDue, lostOutcome }) => {
      switch (notice) {
        case "opened":
          return `Quien compró abrió una disputa sobre ${subject}. Ithas Fire retiene la parte del pago afectada mientras el banco revisa la disputa. ${
            evidenceDue
              ? `La evidencia se debe presentar a más tardar el ${evidenceDue}.`
              : "No se indicó una fecha límite para presentar evidencia."
          }`;
        case "under_review":
          return `La disputa sobre ${subject} está en revisión. La parte del pago afectada sigue retenida mientras el banco revisa la disputa.`;
        case "funds_withdrawn":
          return `Stripe retiró los fondos de la disputa sobre ${subject}. La parte del pago afectada sigue retenida mientras el banco revisa la disputa.`;
        case "won":
          return `La disputa sobre ${subject} se resolvió a tu favor. No se descontará nada de tus pagos por ella. Se liberó cualquier retención sobre la parte del pago afectada, y se te devolvió cualquier monto ya descontado por esta disputa.`;
        case "lost": {
          const lost = `La disputa sobre ${subject} se resolvió en tu contra.`;
          switch (lostOutcome ?? "ticketing_debited") {
            case "membership_debited_with_fee":
              return `${lost} El monto en disputa, más la comisión por disputa de la red de tarjetas, se descontará de tus próximos pagos.`;
            case "membership_debited":
              return `${lost} El monto en disputa se descontará de tus próximos pagos.`;
            case "membership_fee_debited":
              return `${lost} No se descontará nada más de tus pagos por el monto en disputa. La comisión por disputa de la red de tarjetas se descontará de tus próximos pagos.`;
            case "membership_not_debited":
              return `${lost} No se descontará nada más de tus pagos por el monto en disputa.`;
            case "ticketing_not_debited":
              return `${lost} No se descontará nada más de tus pagos por esta disputa. La comisión por disputa de la red de tarjetas no se te traslada.`;
            case "ticketing_debited":
              return `${lost} El monto en disputa se descontará de tus próximos pagos. La comisión por disputa de la red de tarjetas no se te traslada.`;
          }
        }
      }
    },
  },
};
