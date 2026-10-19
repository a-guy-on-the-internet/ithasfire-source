import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// Pins the in-app copy of the converted money + RSVP notices, per locale.
// English is pinned EXACTLY (it is what `notify` stores and what email, push
// and search see); Spanish is pinned so a copy edit is a visible diff.

const NOW = new Date("2026-11-13T12:00:00Z");
const U = "11111111-0000-4000-8000-000000000001";
const E = "22222222-0000-4000-8000-000000000002";
const D = "33333333-0000-4000-8000-000000000003";

// ICU puts a narrow no-break space before "PM"; compare on plain spaces.
const plain = (s: string | null | undefined) =>
  (s ?? "").replace(/[  ]/gu, " ");

const render = (
  variant: string,
  payload: unknown,
  locale?: "en" | "es",
  now = NOW,
) => renderNotification(variant, payload, { now, locale });

describe("rsvp.reminder copy", () => {
  const payload = {
    eventId: E,
    eventTitle: "Open Mic Night",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    venueName: "The Hall",
    eventUrl: "https://ithas.fire/e/open-mic-night",
    manageRsvpsUrl: "https://ithas.fire/my-rsvps",
  };

  it("en: today", () => {
    const out = render("rsvp.reminder", payload);
    expect(out.inApp?.title).toBe("Today: Open Mic Night");
    expect(plain(out.inApp?.body)).toBe(
      "Open Mic Night is today. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    expect(out.inApp?.action).toEqual({
      label: "View event",
      route: "/e/open-mic-night",
    });
    expect(out.push?.title).toBe("Today: Open Mic Night");
    expect(plain(out.push?.body)).toBe(
      "Starts Fri, Nov 13, 2026, 7:30 PM CST. Tap for details.",
    );
    expect(out.email?.subject).toBe("Today: Open Mic Night");
    expect(plain(out.email?.text)).toBe(
      [
        "Open Mic Night is today. It starts Fri, Nov 13, 2026, 7:30 PM CST. You said you're going.",
        "Where: The Hall",
        "View the event: https://ithas.fire/e/open-mic-night",
        "Plans changed? Manage your RSVPs: https://ithas.fire/my-rsvps",
      ].join("\n\n"),
    );
  });

  it("en: tomorrow and coming up", () => {
    const tomorrow = render(
      "rsvp.reminder",
      payload,
      "en",
      new Date("2026-11-12T12:00:00Z"),
    );
    expect(tomorrow.inApp?.title).toBe("Tomorrow: Open Mic Night");
    expect(plain(tomorrow.inApp?.body)).toBe(
      "Open Mic Night is tomorrow. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    const later = render(
      "rsvp.reminder",
      payload,
      "en",
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(later.inApp?.title).toBe("Coming up: Open Mic Night");
    expect(plain(later.inApp?.body)).toBe(
      "Open Mic Night is coming up. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
  });

  it("en: a Los Angeles show at 10:30 PM is still today", () => {
    // 22:30 PST Fri Nov 13 = 06:30Z Sat Nov 14 (00:30 CST, also Saturday);
    // now is noon PST Friday.
    const out = render(
      "rsvp.reminder",
      {
        ...payload,
        startsAtIso: "2026-11-14T06:30:00.000Z",
        timezone: "America/Los_Angeles",
      },
      "en",
      new Date("2026-11-13T20:00:00Z"),
    );
    expect(out.inApp?.title).toBe("Today: Open Mic Night");
    expect(plain(out.inApp?.body)).toBe(
      "Open Mic Night is today. It starts Fri, Nov 13, 2026, 10:30 PM PST.",
    );
  });

  // The day label used to read a zone-less row in UTC: a 9:30 PM CST show
  // (03:30Z the next day) was "Tomorrow" at noon the same day.
  it.each([null, undefined, "Not/AZone"])(
    "en: no usable zone (%s) reads Today/Tomorrow in the platform default",
    (timezone) => {
      const zoneless: Record<string, unknown> = {
        ...payload,
        startsAtIso: "2026-11-14T03:30:00.000Z",
      };
      delete zoneless.timezone;
      const out = render(
        "rsvp.reminder",
        timezone === undefined ? zoneless : { ...zoneless, timezone },
        "en",
        new Date("2026-11-13T18:00:00Z"),
      );
      expect(out.inApp?.title).toBe("Today: Open Mic Night");
      expect(plain(out.inApp?.body)).toBe(
        "Open Mic Night is today. It starts Fri, Nov 13, 2026, 9:30 PM CST.",
      );
      // The HTML template reads the same zone, so its WHEN line agrees.
      expect(out.email?.template?.variables).toMatchObject({
        timezone: "America/Chicago",
      });
    },
  );

  it("en: bad start omits the date sentence; push falls back to the English body", () => {
    const out = render("rsvp.reminder", { ...payload, startsAtIso: "nope" });
    expect(out.inApp?.body).toBe("Open Mic Night is coming up.");
    expect(out.push?.body).toBe("Open Mic Night is coming up.");
  });

  it("es: today, tomorrow, coming up", () => {
    const today = render("rsvp.reminder", payload, "es");
    expect(today.inApp?.title).toBe("Hoy: Open Mic Night");
    expect(plain(today.inApp?.body)).toMatch(
      /^Open Mic Night es hoy\. Empieza el viernes 13 de noviembre de 2026 a las 19:30 \([^)]+\)\.$/u,
    );
    expect(today.inApp?.action?.label).toBe("Ver evento");

    const tomorrow = render(
      "rsvp.reminder",
      payload,
      "es",
      new Date("2026-11-12T12:00:00Z"),
    );
    expect(tomorrow.inApp?.title).toBe("Mañana: Open Mic Night");
    expect(tomorrow.inApp?.body).toMatch(/^Open Mic Night es mañana\. Empieza el /u);

    const later = render(
      "rsvp.reminder",
      payload,
      "es",
      new Date("2026-11-01T12:00:00Z"),
    );
    expect(later.inApp?.title).toBe("Se acerca: Open Mic Night");
    expect(later.inApp?.body).toMatch(/^Open Mic Night se acerca\. Empieza el /u);
  });

  it("es: push, email and fingerprint stay English", () => {
    const en = render("rsvp.reminder", payload);
    const es = render("rsvp.reminder", payload, "es");
    expect(es.push).toEqual(en.push);
    expect(es.email).toEqual(en.email);
    expect(es.fingerprint).toEqual(en.fingerprint);
  });
});

describe("rsvp.date_cancelled copy", () => {
  const payload = {
    eventId: E,
    eventDateId: D,
    eventTitle: "Weekly Open Mic",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    venueName: "The Hall",
    eventUrl: "https://ithas.fire/e/open-mic",
  };

  it("en: names the date", () => {
    const out = render("rsvp.date_cancelled", payload);
    expect(plain(out.inApp?.title)).toBe(
      "Cancelled: Weekly Open Mic on Fri, Nov 13, 2026, 7:30 PM CST",
    );
    expect(plain(out.inApp?.body)).toBe(
      "The Fri, Nov 13, 2026, 7:30 PM CST date of Weekly Open Mic has been called off. Your RSVP for that night is cancelled; the rest of the schedule is unchanged.",
    );
    expect(out.inApp?.action).toEqual({
      label: "See other dates",
      route: "/e/open-mic",
    });
    expect(plain(out.email?.subject)).toBe(
      "Cancelled: Weekly Open Mic on Fri, Nov 13, 2026, 7:30 PM CST",
    );
    expect(plain(out.email?.text)).toBe(
      [
        "The Fri, Nov 13, 2026, 7:30 PM CST date of Weekly Open Mic has been called off. Your RSVP for that night is cancelled; the rest of the schedule is unchanged.",
        "Where it would have been: The Hall",
        "See the other dates: https://ithas.fire/e/open-mic",
      ].join("\n\n"),
    );
  });

  it("en: bad start drops the date", () => {
    const out = render("rsvp.date_cancelled", { ...payload, startsAtIso: "x" });
    expect(out.inApp?.title).toBe("Cancelled: Weekly Open Mic");
    expect(out.inApp?.body).toBe(
      "One date of Weekly Open Mic has been called off. Your RSVP for that night is cancelled; the rest of the schedule is unchanged.",
    );
  });

  it("es: names the date; email stays English", () => {
    const out = render("rsvp.date_cancelled", payload, "es");
    expect(plain(out.inApp?.title)).toMatch(
      /^Fecha cancelada: Weekly Open Mic, viernes 13 de noviembre de 2026 a las 19:30 \([^)]+\)$/u,
    );
    expect(plain(out.inApp?.body)).toMatch(
      /^Se canceló la fecha de Weekly Open Mic del viernes 13 de noviembre de 2026 a las 19:30 \([^)]+\)\. Tu asistencia para esa noche queda cancelada; las demás fechas siguen igual\.$/u,
    );
    expect(out.inApp?.action?.label).toBe("Ver otras fechas");
    expect(out.email).toEqual(render("rsvp.date_cancelled", payload).email);

    const bad = render("rsvp.date_cancelled", { ...payload, startsAtIso: "x" }, "es");
    expect(bad.inApp?.title).toBe("Fecha cancelada: Weekly Open Mic");
    expect(bad.inApp?.body).toBe(
      "Se canceló una fecha de Weekly Open Mic. Tu asistencia para esa noche queda cancelada; las demás fechas siguen igual.",
    );
  });

  // The whole listing is off (cancel/archive take-down): one message per
  // person stands for every remaining night, so no date, no venue, no
  // "other dates" link, and never "the rest of the schedule is unchanged".
  const listingPayload = { ...payload, eventUrl: null, listingCancelled: true };

  it("en: whole listing cancelled says so, with no other-dates link", () => {
    const out = render("rsvp.date_cancelled", listingPayload);
    expect(out.inApp?.title).toBe("Cancelled: Weekly Open Mic");
    expect(out.inApp?.body).toBe(
      "None of its remaining nights will happen. Your RSVP is cancelled.",
    );
    expect(out.inApp?.action).toBeNull();
    expect(out.email?.subject).toBe("Cancelled: Weekly Open Mic");
    expect(out.email?.text).toBe(
      "None of its remaining nights will happen. Your RSVP is cancelled.",
    );
    expect(out.email?.template).toMatchObject({
      key: "rsvp.date_cancelled",
      variables: { eventUrl: null, listingCancelled: true },
    });
    expect(out.push).toBeUndefined();
    expect(out.fingerprint).toMatchObject({ listingCancelled: true });
  });

  // The drain sends a link only for a CANCELLED listing (its page says
  // "Event cancelled"); the renderer shows whatever link it is given, as a
  // plain "View event", never "other dates".
  it("en: whole listing with an eventUrl links to the event page, not other dates", () => {
    const out = render("rsvp.date_cancelled", {
      ...listingPayload,
      eventUrl: "https://ithas.fire/e/open-mic",
    });
    expect(out.inApp?.action).toEqual({ label: "View event", route: "/e/open-mic" });
    expect(out.email?.text).toBe(
      "None of its remaining nights will happen. Your RSVP is cancelled.\n\n" +
        "View the event: https://ithas.fire/e/open-mic",
    );
    expect(out.email?.text).not.toContain("other dates");
    expect(out.email?.template).toMatchObject({
      variables: {
        eventUrl: "https://ithas.fire/e/open-mic",
        listingCancelled: true,
      },
    });
  });

  it("es: whole listing with an eventUrl labels the link in Spanish", () => {
    const out = render(
      "rsvp.date_cancelled",
      { ...listingPayload, eventUrl: "https://ithas.fire/e/open-mic" },
      "es",
    );
    expect(out.inApp?.action).toEqual({ label: "Ver evento", route: "/e/open-mic" });
  });

  it("es: whole listing cancelled; email stays English", () => {
    const out = render("rsvp.date_cancelled", listingPayload, "es");
    expect(out.inApp?.title).toBe("Evento cancelado: Weekly Open Mic");
    expect(out.inApp?.body).toBe(
      "Ninguna de sus próximas fechas se va a realizar. Tu asistencia queda cancelada.",
    );
    expect(out.inApp?.action).toBeNull();
    expect(out.email).toEqual(render("rsvp.date_cancelled", listingPayload).email);
  });

  it("one-night call-off: no listingCancelled in the fingerprint or template", () => {
    const out = render("rsvp.date_cancelled", payload);
    expect(out.fingerprint).not.toHaveProperty("listingCancelled");
    expect(
      (out.email?.template as { variables: Record<string, unknown> }).variables,
    ).not.toHaveProperty("listingCancelled");
  });
});

describe("order.confirmed copy", () => {
  const payload = {
    orderId: U,
    eventId: E,
    eventTitle: "Sunset Sessions",
    ticketCount: 1,
    amountCents: 2_500,
    currency: "usd",
  };

  it("en: singular, with push pinned", () => {
    const out = render("order.confirmed", payload);
    expect(out.inApp?.title).toBe("You're going to Sunset Sessions!");
    expect(out.inApp?.body).toBe(
      "Your 1 ticket for Sunset Sessions ($25.00) is confirmed and ready in your account.",
    );
    expect(out.push?.title).toBe("You're going to Sunset Sessions!");
    expect(out.push?.body).toBe("Your 1 ticket for Sunset Sessions is confirmed.");
  });

  it("en: plural push", () => {
    const out = render("order.confirmed", { ...payload, ticketCount: 2 });
    expect(out.push?.body).toBe("Your 2 tickets for Sunset Sessions are confirmed.");
  });

  it("es: agrees in number; push stays English", () => {
    const one = render("order.confirmed", payload, "es");
    expect(one.inApp?.title).toBe("¡Vas a ir a Sunset Sessions!");
    expect(one.inApp?.body).toBe(
      "Tu entrada para Sunset Sessions ($25.00) está confirmada y lista en tu cuenta.",
    );
    expect(one.inApp?.action).toEqual({
      label: "Ver entradas",
      route: "/my-tickets",
    });
    const two = render("order.confirmed", { ...payload, ticketCount: 2 }, "es");
    expect(two.inApp?.body).toBe(
      "Tus 2 entradas para Sunset Sessions ($25.00) están confirmadas y listas en tu cuenta.",
    );
    expect(one.push).toEqual(render("order.confirmed", payload).push);
    expect(two.push).toEqual(
      render("order.confirmed", { ...payload, ticketCount: 2 }).push,
    );
  });
});

describe("order.refund-processed copy", () => {
  const payload = {
    orderId: U,
    refundId: "re_123",
    eventId: E,
    eventTitle: "Sunset Sessions",
    amountCents: 1_000,
    currency: "usd",
    status: "PART_REFUNDED",
  };

  it("en: push pinned; no-event variant", () => {
    const out = render("order.refund-processed", payload);
    expect(out.push?.title).toBe("Partial refund processed");
    expect(out.push?.body).toBe(
      "$10.00 for Sunset Sessions is on its way back to your payment method.",
    );
    const bare = render("order.refund-processed", {
      ...payload,
      status: "REFUNDED",
      eventTitle: null,
    });
    expect(bare.inApp?.body).toBe(
      "Your refund of $10.00 is on its way back to your original payment method.",
    );
  });

  it("es: full, partial, with and without event; push stays English", () => {
    const partial = render("order.refund-processed", payload, "es");
    expect(partial.inApp?.title).toBe("Reembolso parcial procesado");
    expect(partial.inApp?.body).toBe(
      "Tu reembolso parcial de $10.00 por tu pedido para Sunset Sessions ya va de camino a tu método de pago original.",
    );
    expect(partial.inApp?.action).toEqual({
      label: "Ver pedidos",
      route: "/my-tickets",
    });
    const fullBare = render(
      "order.refund-processed",
      { ...payload, status: "REFUNDED", eventTitle: null },
      "es",
    );
    expect(fullBare.inApp?.title).toBe("Reembolso procesado");
    expect(fullBare.inApp?.body).toBe(
      "Tu reembolso de $10.00 ya va de camino a tu método de pago original.",
    );
    const fullWithEvent = render(
      "order.refund-processed",
      { ...payload, status: "REFUNDED" },
      "es",
    );
    expect(fullWithEvent.inApp?.body).toBe(
      "Tu reembolso de $10.00 por tu pedido para Sunset Sessions ya va de camino a tu método de pago original.",
    );
    const partialBare = render(
      "order.refund-processed",
      { ...payload, eventTitle: null },
      "es",
    );
    expect(partialBare.inApp?.body).toBe(
      "Tu reembolso parcial de $10.00 ya va de camino a tu método de pago original.",
    );
    expect(partial.push).toEqual(render("order.refund-processed", payload).push);
  });

  // A refund that moved no money (owner ruling 2026-10-11: a ticket that
  // cost $0 refunds $0): "ticket returned", in the render locale.
  it("es: a $0 refund is 'Entrada devuelta', singular and plural, with and without event; push stays English", () => {
    const zero = { ...payload, amountCents: 0, ticketCount: 1 };
    const one = render("order.refund-processed", zero, "es");
    expect(one.inApp?.title).toBe("Entrada devuelta");
    expect(one.inApp?.body).toBe(
      "Tu entrada para Sunset Sessions fue devuelta. No hay dinero que reembolsar por ella.",
    );
    expect(one.inApp?.kind).toBe("INFO");
    expect(one.inApp?.action).toEqual({
      label: "Ver pedidos",
      route: "/my-tickets",
    });
    expect(one.push?.title).toBe("Ticket returned");
    expect(one.push?.body).toBe(
      "Your ticket for Sunset Sessions was returned. There is no money to refund for it.",
    );

    const many = render(
      "order.refund-processed",
      { ...zero, ticketCount: 2, status: "REFUNDED" },
      "es",
    );
    expect(many.inApp?.title).toBe("Entradas devueltas");
    expect(many.inApp?.body).toBe(
      "Tus entradas para Sunset Sessions fueron devueltas. No hay dinero que reembolsar por ellas.",
    );

    const bare = render(
      "order.refund-processed",
      { ...zero, eventTitle: null },
      "es",
    );
    expect(bare.inApp?.body).toBe(
      "Tu entrada fue devuelta. No hay dinero que reembolsar por ella.",
    );
    for (const out of [one, many, bare]) {
      expect(out.inApp?.body).not.toMatch(/de camino|reembolso parcial/);
    }
  });
});

describe("resale.purchase-confirmed copy", () => {
  const payload = {
    orderId: U,
    eventId: E,
    eventTitle: "Sunset Sessions",
    amountCents: 4_000,
    currency: "usd",
  };

  it("en: push pinned", () => {
    const out = render("resale.purchase-confirmed", payload);
    expect(out.push?.title).toBe("You're going to Sunset Sessions!");
    expect(out.push?.body).toBe("Your resale ticket for Sunset Sessions is confirmed.");
  });

  it("es: in-app only", () => {
    const out = render("resale.purchase-confirmed", payload, "es");
    expect(out.inApp?.title).toBe("¡Vas a ir a Sunset Sessions!");
    expect(out.inApp?.body).toBe(
      "Tu entrada de reventa para Sunset Sessions ($40.00) está confirmada. Generamos un código QR nuevo; lo encontrarás en tu cuenta.",
    );
    expect(out.inApp?.action).toEqual({
      label: "Ver entrada",
      route: "/my-tickets",
    });
    expect(out.push).toEqual(render("resale.purchase-confirmed", payload).push);
  });
});

describe("settlement.payout-completed copy", () => {
  const base = {
    payeeId: U,
    payoutId: E,
    payoutItemId: D,
    amountCents: 12_500,
    currency: "usd",
    settlementCount: 2,
    payoutsUrl: "https://ithas.fire/admin/acme/payments",
  };

  it("es: payout, applied, reserved; singular sale; email stays English", () => {
    const paid = render("settlement.payout-completed", base, "es");
    expect(paid.inApp?.title).toBe("Pago enviado");
    expect(paid.inApp?.body).toBe(
      "Enviamos $125.00 de 2 ventas a tu cuenta de Stripe.",
    );
    expect(paid.inApp?.action).toEqual({
      label: "Ver pagos",
      href: "https://ithas.fire/admin/acme/payments",
    });
    const one = render(
      "settlement.payout-completed",
      { ...base, settlementCount: 1 },
      "es",
    );
    expect(one.inApp?.body).toBe(
      "Enviamos $125.00 de 1 venta a tu cuenta de Stripe.",
    );

    const applied = render(
      "settlement.payout-completed",
      { ...base, kind: "applied_to_balance" },
      "es",
    );
    expect(applied.inApp?.title).toBe("Pago aplicado a tu saldo pendiente");
    expect(applied.inApp?.body).toBe(
      "Usamos $125.00 de 2 ventas para cubrir tu saldo pendiente por una disputa perdida. No se envió ninguna transferencia bancaria.",
    );

    const reserved = render(
      "settlement.payout-completed",
      { ...base, kind: "reserved" },
      "es",
    );
    expect(reserved.inApp?.title).toBe("Pago retenido como reserva");
    expect(reserved.inApp?.body).toBe(
      "Retuvimos $125.00 de 2 ventas como reserva; se liberará en un pago futuro. No se envió ninguna transferencia bancaria.",
    );

    const en = render("settlement.payout-completed", base);
    expect(paid.email).toEqual(en.email);
    expect(paid.fingerprint).toEqual(en.fingerprint);
    expect(applied.email).toEqual(
      render("settlement.payout-completed", { ...base, kind: "applied_to_balance" })
        .email,
    );
    expect(reserved.email).toEqual(
      render("settlement.payout-completed", { ...base, kind: "reserved" }).email,
    );
  });

  it("es: no payoutsUrl, no action", () => {
    const { payoutsUrl: _omit, ...rest } = base;
    expect(
      render("settlement.payout-completed", rest, "es").inApp?.action,
    ).toBeNull();
  });
});
