import { describe, expect, it } from "vitest";

import type { NotificationLocale } from "../locale";
import { renderNotification } from "../renderers";

// Exact in-app copy, en and es, for every branch of the direct-write resale,
// dispute and listing-report variants (direct-money-safety-renderers.ts).
// English is the producers' original text, byte for byte (also pinned through
// the producers in resale/, disputes/ and entity-reports/ __tests__).

const NOW = new Date("2026-11-01T12:00:00Z");

function render(variant: string, payload: unknown, locale: NotificationLocale) {
  const out = renderNotification(variant, payload, { now: NOW, locale });
  expect(out.email).toBeUndefined();
  expect(out.push).toBeUndefined();
  const inApp = out.inApp!;
  return {
    title: inApp.title,
    body: inApp.body,
    kind: inApp.kind,
    label: inApp.action?.label ?? null,
    href: inApp.action?.href ?? inApp.action?.route ?? null,
  };
}

type Pin = {
  title: string;
  body: string;
  label: string | null;
};

function pin(
  variant: string,
  payload: Record<string, unknown>,
  en: Pin,
  es: Pin,
) {
  const outEn = render(variant, payload, "en");
  const outEs = render(variant, payload, "es");
  expect({ title: outEn.title, body: outEn.body, label: outEn.label }).toEqual(en);
  expect({ title: outEs.title, body: outEs.body, label: outEs.label }).toEqual(es);
  // Only the words change with the locale.
  expect(outEs.kind).toBe(outEn.kind);
  expect(outEs.href).toBe(outEn.href);
}

const URL = "https://ithas.fire/my/resale";
const CLAIM_URL = "https://ithas.fire/my/resale/claims/c1";

describe("resale.listing-created", () => {
  const base = {
    listingId: "l1",
    eventTitle: "Sunset Sessions",
    askPriceCents: 2500,
    currency: "usd",
    listingUrl: URL,
  };
  it("with the event", () =>
    pin(
      "resale.listing-created",
      base,
      {
        title: "Ticket listed for resale",
        body: "Your ticket for Sunset Sessions is now listed at $25.00.",
        label: "View listing",
      },
      {
        title: "Entrada publicada en reventa",
        body: "Tu entrada para Sunset Sessions ya está en reventa a $25.00.",
        label: "Ver anuncio",
      },
    ));
  it("event gone", () =>
    pin(
      "resale.listing-created",
      { ...base, eventTitle: null },
      {
        title: "Ticket listed for resale",
        body: "Your ticket for your event is now listed at $25.00.",
        label: "View listing",
      },
      {
        title: "Entrada publicada en reventa",
        body: "Tu entrada ya está en reventa a $25.00.",
        label: "Ver anuncio",
      },
    ));
});

describe("resale.claim-opened", () => {
  const base = {
    claimId: "c1",
    eventTitle: "Sunset Sessions",
    claimKind: "ticket_invalid",
    deadlineIso: "2026-09-13T12:00:00.000Z",
    claimUrl: CLAIM_URL,
  };
  it.each([
    ["ticket_invalid", "ticket invalid", "entrada no válida"],
    ["entry_denied", "entry denied", "acceso denegado"],
    ["wrong_seat", "wrong seat", "asiento incorrecto"],
    ["other", "other", "otro motivo"],
    ["some_new_kind", "some new kind", "some new kind"],
  ])("%s", (claimKind, enKind, esKind) =>
    pin(
      "resale.claim-opened",
      { ...base, claimKind },
      {
        title: "Claim filed against your sale",
        body: `A buyer has filed a "${enKind}" claim on your resale ticket for Sunset Sessions. Reply with your side as soon as you can: support can decide the claim at any time.`,
        label: "View claim",
      },
      {
        title: "Presentaron una reclamación sobre tu venta",
        body: `Quien compró tu entrada de reventa para Sunset Sessions presentó una reclamación por «${esKind}». Responde con tu versión lo antes posible: el equipo de soporte puede resolver la reclamación en cualquier momento.`,
        label: "Ver reclamación",
      },
    ),
  );
  it("event gone", () =>
    pin(
      "resale.claim-opened",
      { ...base, eventTitle: null },
      {
        title: "Claim filed against your sale",
        body: 'A buyer has filed a "ticket invalid" claim on your resale ticket for your event. Reply with your side as soon as you can: support can decide the claim at any time.',
        label: "View claim",
      },
      {
        title: "Presentaron una reclamación sobre tu venta",
        body: "Quien compró tu entrada de reventa presentó una reclamación por «entrada no válida». Responde con tu versión lo antes posible: el equipo de soporte puede resolver la reclamación en cualquier momento.",
        label: "Ver reclamación",
      },
    ));
});

describe("resale.claim-resolved", () => {
  const base = {
    claimId: "c1",
    eventTitle: "Sunset Sessions",
    resolution: null,
    claimUrl: CLAIM_URL,
  };
  // An approved claim is always a full refund (owner ruling Q5, 2026-10-06),
  // whatever resolution the row carries.
  it.each([
    [
      "full_refund",
      "A full refund will be processed.",
      "Se procesará un reembolso completo.",
    ],
    [
      null,
      "A full refund will be processed.",
      "Se procesará un reembolso completo.",
    ],
  ])("buyer, approved (%s)", (resolution, enNext, esNext) =>
    pin(
      "resale.claim-resolved",
      { ...base, audience: "buyer", status: "approved", resolution },
      {
        title: "Your claim has been approved",
        body: `Your claim for the Sunset Sessions resale ticket has been approved. ${enNext}`,
        label: "View claim",
      },
      {
        title: "Tu reclamación fue aprobada",
        body: `Tu reclamación sobre la entrada de reventa para Sunset Sessions fue aprobada. ${esNext}`,
        label: "Ver reclamación",
      },
    ),
  );
  it("buyer, denied", () =>
    pin(
      "resale.claim-resolved",
      { ...base, audience: "buyer", status: "denied" },
      {
        title: "Your claim has been denied",
        body: "Your claim for the Sunset Sessions resale ticket has been denied. See the claim details for more information.",
        label: "View claim",
      },
      {
        title: "Tu reclamación no fue aprobada",
        body: "Tu reclamación sobre la entrada de reventa para Sunset Sessions no fue aprobada. Consulta los detalles de la reclamación para más información.",
        label: "Ver reclamación",
      },
    ));
  it("seller, approved (refund issued)", () =>
    pin(
      "resale.claim-resolved",
      { ...base, audience: "seller", status: "approved", resolution: "full_refund" },
      {
        title: "Claim resolved — refund issued",
        body: "A claim on your resale ticket for Sunset Sessions has been resolved in the buyer's favor. The payout for this sale has been adjusted accordingly.",
        label: "View details",
      },
      {
        title: "Reclamación resuelta: se emitió un reembolso",
        body: "Una reclamación sobre tu entrada de reventa para Sunset Sessions se resolvió a favor de quien compró. El pago de esta venta se ajustó en consecuencia.",
        label: "Ver detalles",
      },
    ));
  it("seller, denied (in your favor), event gone", () =>
    pin(
      "resale.claim-resolved",
      { ...base, eventTitle: null, audience: "seller", status: "denied" },
      {
        title: "Claim resolved in your favor",
        body: "A claim on your resale ticket for your event has been resolved in your favor. The money from this sale is no longer on hold and will be paid out as usual.",
        label: "View details",
      },
      {
        title: "Reclamación resuelta a tu favor",
        body: "Una reclamación sobre tu entrada de reventa se resolvió a tu favor. El dinero de esta venta ya no está retenido y se pagará como de costumbre.",
        label: "Ver detalles",
      },
    ));
});

describe("resale.claim-refunded", () => {
  const base = {
    claimId: "c1",
    orderId: "o1",
    eventTitle: "Sunset Sessions",
    amountCents: 5500,
    currency: "usd",
    orderUrl: "https://ithas.fire/my-tickets/o1",
  };
  it("with the event", () =>
    pin(
      "resale.claim-refunded",
      base,
      {
        title: "We've refunded you",
        body: "We refunded $55.00 for the Sunset Sessions resale ticket to the payment method you used. Your bank can take 5 to 10 business days to show it.",
        label: "View order",
      },
      {
        title: "Te reembolsamos",
        body: "Te devolvimos $55.00 por la entrada de reventa para Sunset Sessions al mismo medio de pago que usaste. Tu banco puede tardar de 5 a 10 días hábiles en mostrarlo.",
        label: "Ver pedido",
      },
    ));
  it("event gone", () =>
    pin(
      "resale.claim-refunded",
      { ...base, eventTitle: null },
      {
        title: "We've refunded you",
        body: "We refunded $55.00 for your resale ticket to the payment method you used. Your bank can take 5 to 10 business days to show it.",
        label: "View order",
      },
      {
        title: "Te reembolsamos",
        body: "Te devolvimos $55.00 por la entrada de reventa al mismo medio de pago que usaste. Tu banco puede tardar de 5 a 10 días hábiles en mostrarlo.",
        label: "Ver pedido",
      },
    ));
  it("links to the order page in both languages", () => {
    expect(render("resale.claim-refunded", base, "en").href).toBe(
      "https://ithas.fire/my-tickets/o1",
    );
    expect(render("resale.claim-refunded", base, "es").href).toBe(
      "https://ithas.fire/my-tickets/o1",
    );
  });
});

describe("resale.seller-sold", () => {
  const base = {
    listingId: "l1",
    orderId: "o1",
    eventTitle: "Sunset Sessions",
    amountCents: 4250,
    currency: "usd",
    resaleUrl: URL,
  };
  it("with the event", () =>
    pin(
      "resale.seller-sold",
      base,
      {
        title: "Ticket sold!",
        body: "Your ticket for Sunset Sessions sold for $42.50. Payout will be processed after the event.",
        label: "View details",
      },
      {
        title: "¡Vendiste tu entrada!",
        body: "Tu entrada para Sunset Sessions se vendió por $42.50. El pago se procesará después del evento.",
        label: "Ver detalles",
      },
    ));
  it("event gone", () =>
    pin(
      "resale.seller-sold",
      { ...base, eventTitle: null },
      {
        title: "Ticket sold!",
        body: "Your ticket for your event sold for $42.50. Payout will be processed after the event.",
        label: "View details",
      },
      {
        title: "¡Vendiste tu entrada!",
        body: "Tu entrada se vendió por $42.50. El pago se procesará después del evento.",
        label: "Ver detalles",
      },
    ));
});

describe("dispute.risk-owner-notice", () => {
  const base = {
    disputeId: "d1",
    eventTitle: "Spring Gala",
    isMembership: false,
    evidenceDueIso: "2026-03-24T12:00:00.000Z",
    lostOutcome: null,
  };
  const HELD_EN =
    "The affected payout share remains held while the bank reviews the dispute.";
  const HELD_ES =
    "La parte del pago afectada sigue retenida mientras el banco revisa la disputa.";

  it("opened", () =>
    pin(
      "dispute.risk-owner-notice",
      { ...base, notice: "opened" },
      {
        title: "Dispute opened",
        body: "A buyer dispute was opened for Spring Gala. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due Mar 24, 2026.",
        label: null,
      },
      {
        title: "Se abrió una disputa",
        body: "Quien compró abrió una disputa sobre Spring Gala. Ithas Fire retiene la parte del pago afectada mientras el banco revisa la disputa. La evidencia se debe presentar a más tardar el martes 24 de marzo de 2026.",
        label: null,
      },
    ));
  it("opened, membership, no evidence date", () =>
    pin(
      "dispute.risk-owner-notice",
      {
        ...base,
        notice: "opened",
        eventTitle: null,
        isMembership: true,
        evidenceDueIso: null,
      },
      {
        title: "Dispute opened",
        body: "A buyer dispute was opened for your membership. Ithas Fire is holding the affected payout share while the bank reviews the dispute. Evidence is due not provided.",
        label: null,
      },
      {
        title: "Se abrió una disputa",
        body: "Quien compró abrió una disputa sobre tu membresía. Ithas Fire retiene la parte del pago afectada mientras el banco revisa la disputa. No se indicó una fecha límite para presentar evidencia.",
        label: null,
      },
    ));
  it("under review, event gone", () =>
    pin(
      "dispute.risk-owner-notice",
      { ...base, notice: "under_review", eventTitle: null },
      {
        title: "Dispute under review",
        body: `The buyer dispute for your event is under review. ${HELD_EN}`,
        label: null,
      },
      {
        title: "Disputa en revisión",
        body: `La disputa sobre tu evento está en revisión. ${HELD_ES}`,
        label: null,
      },
    ));
  it("funds withdrawn", () =>
    pin(
      "dispute.risk-owner-notice",
      { ...base, notice: "funds_withdrawn" },
      {
        title: "Dispute funds withdrawn",
        body: `Stripe has withdrawn funds for the dispute on Spring Gala. ${HELD_EN}`,
        label: null,
      },
      {
        title: "Fondos retirados por una disputa",
        body: `Stripe retiró los fondos de la disputa sobre Spring Gala. ${HELD_ES}`,
        label: null,
      },
    ));
  it("won", () =>
    pin(
      "dispute.risk-owner-notice",
      { ...base, notice: "won" },
      {
        title: "Dispute won",
        body: "The dispute for Spring Gala was won. Nothing will be deducted from your payouts for it. Any hold on the affected payout share has been released, and any amount already deducted for this dispute has been credited back.",
        label: null,
      },
      {
        title: "Disputa ganada",
        body: "La disputa sobre Spring Gala se resolvió a tu favor. No se descontará nada de tus pagos por ella. Se liberó cualquier retención sobre la parte del pago afectada, y se te devolvió cualquier monto ya descontado por esta disputa.",
        label: null,
      },
    ));
  it.each([
    [
      "ticketing_debited",
      "The disputed amount will be deducted from your upcoming payouts. The card network's dispute fee is not passed on to you.",
      "El monto en disputa se descontará de tus próximos pagos. La comisión por disputa de la red de tarjetas no se te traslada.",
    ],
    [
      "ticketing_not_debited",
      "Nothing further will be deducted from your payouts for this dispute. The card network's dispute fee is not passed on to you.",
      "No se descontará nada más de tus pagos por esta disputa. La comisión por disputa de la red de tarjetas no se te traslada.",
    ],
    [
      "membership_debited_with_fee",
      "The disputed amount plus the card network's dispute fee will be deducted from your upcoming payouts.",
      "El monto en disputa, más la comisión por disputa de la red de tarjetas, se descontará de tus próximos pagos.",
    ],
    [
      "membership_debited",
      "The disputed amount will be deducted from your upcoming payouts.",
      "El monto en disputa se descontará de tus próximos pagos.",
    ],
    [
      "membership_fee_debited",
      "Nothing further will be deducted from your payouts for the disputed amount. The card network's dispute fee will be deducted from your upcoming payouts.",
      "No se descontará nada más de tus pagos por el monto en disputa. La comisión por disputa de la red de tarjetas se descontará de tus próximos pagos.",
    ],
    [
      "membership_not_debited",
      "Nothing further will be deducted from your payouts for the disputed amount.",
      "No se descontará nada más de tus pagos por el monto en disputa.",
    ],
  ])("lost: %s", (lostOutcome, enTail, esTail) =>
    pin(
      "dispute.risk-owner-notice",
      { ...base, notice: "lost", lostOutcome },
      {
        title: "Dispute lost",
        body: `The dispute for Spring Gala was lost. ${enTail}`,
        label: null,
      },
      {
        title: "Disputa perdida",
        body: `La disputa sobre Spring Gala se resolvió en tu contra. ${esTail}`,
        label: null,
      },
    ),
  );
});

describe("entity-report.submitted", () => {
  it.each([
    ["PLACE", "CLOSED_OR_GONE", "a place", "closed or gone", "lugar", "cerrado o desaparecido"],
    ["PLACE", "INCORRECT_INFO", "a place", "incorrect info", "lugar", "información incorrecta"],
    ["PLACE", "DUPLICATE", "a place", "duplicate", "lugar", "duplicado"],
    ["HUMAN", "INAPPROPRIATE", "a profile", "inappropriate", "perfil", "inapropiado"],
    ["HUMAN", "SPAM", "a profile", "spam", "perfil", "spam"],
    ["ORGANIZATION", "IMPERSONATION", "an organization", "impersonation", "grupo", "suplantación de identidad"],
    ["ORGANIZATION", "OTHER", "an organization", "other", "grupo", "otro"],
  ])("%s / %s", (subjectType, reason, enSubject, enReason, esSubject, esReason) =>
    pin(
      "entity-report.submitted",
      { reportId: "r1", subjectType, subjectId: "s1", reason },
      {
        title: "New listing report",
        body: `A visitor reported ${enSubject} listing (${enReason}).`,
        label: "Review report",
      },
      {
        title: "Nuevo reporte de listado",
        body: `Alguien reportó un listado de ${esSubject} (${esReason}).`,
        label: "Revisar reporte",
      },
    ),
  );

  // An arrival area is not a listing: its own title and noun phrase.
  it("ARRIVAL_AREA / INCORRECT_INFO", () =>
    pin(
      "entity-report.submitted",
      { reportId: "r1", subjectType: "ARRIVAL_AREA", subjectId: "s1", reason: "INCORRECT_INFO" },
      {
        title: "New Getting there report",
        body: "A visitor reported a parking, drop-off or load-in area (incorrect info).",
        label: "Review report",
      },
      {
        title: "Nuevo reporte de Cómo llegar",
        body: "Alguien reportó un área de estacionamiento, descenso o carga (información incorrecta).",
        label: "Revisar reporte",
      },
    ));
});

describe("entity-report.reviewed", () => {
  const base = { reportId: "r1", subjectType: "PLACE", subjectId: "s1" };
  it("resolved, with the reviewer's note verbatim", () =>
    pin(
      "entity-report.reviewed",
      { ...base, verdict: "RESOLVED", reviewNote: "Marked closed." },
      {
        title: "Your report was resolved",
        body: "Your report on a place listing was reviewed and resolved. Reviewer note: Marked closed.",
        label: null,
      },
      {
        title: "Tu reporte se resolvió",
        body: "Revisamos tu reporte sobre un listado de lugar y lo resolvimos. Nota de revisión: Marked closed.",
        label: null,
      },
    ));
  it("dismissed, no note", () =>
    pin(
      "entity-report.reviewed",
      { ...base, verdict: "DISMISSED", reviewNote: null },
      {
        title: "Your report was reviewed",
        body: "Your report on a place listing was reviewed and no action was taken.",
        label: null,
      },
      {
        title: "Revisamos tu reporte",
        body: "Revisamos tu reporte sobre un listado de lugar y no tomamos ninguna medida.",
        label: null,
      },
    ));
  // The English article agrees with the noun ("an organization").
  it.each([
    ["HUMAN", "a profile", "perfil"],
    ["ORGANIZATION", "an organization", "grupo"],
  ])("resolved, %s subject", (subjectType, enSubject, esSubject) =>
    pin(
      "entity-report.reviewed",
      { ...base, subjectType, verdict: "RESOLVED", reviewNote: null },
      {
        title: "Your report was resolved",
        body: `Your report on ${enSubject} listing was reviewed and resolved.`,
        label: null,
      },
      {
        title: "Tu reporte se resolvió",
        body: `Revisamos tu reporte sobre un listado de ${esSubject} y lo resolvimos.`,
        label: null,
      },
    ),
  );
  it("dismissed, ARRIVAL_AREA subject", () =>
    pin(
      "entity-report.reviewed",
      { ...base, subjectType: "ARRIVAL_AREA", verdict: "DISMISSED", reviewNote: null },
      {
        title: "Your report was reviewed",
        body: "Your report on a parking, drop-off or load-in area was reviewed and no action was taken.",
        label: null,
      },
      {
        title: "Revisamos tu reporte",
        body: "Revisamos tu reporte sobre un área de estacionamiento, descenso o carga y no tomamos ninguna medida.",
        label: null,
      },
    ));
});
