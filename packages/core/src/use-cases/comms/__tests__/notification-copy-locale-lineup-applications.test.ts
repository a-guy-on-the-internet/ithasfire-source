import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// Pins the exact in-app text (title / body / action label) of the application,
// lineup and bill notices in every locale. English is what rows store and what
// email and push keep saying; it must not move. Organizer/user free text
// (titles, names, reasons, role labels) stays verbatim in every locale.

const NOW = new Date("2026-11-01T12:00:00Z");
const U1 = "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const U2 = "4a2d9e3f-5c6b-4d7e-8f90-0b1c2d3e4f5a";
const U3 = "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b";
const U4 = "6c4f1051-7e8d-4f90-8ab2-2d3e4f5a6b7c";

function inApp(variant: string, payload: unknown, locale: "en" | "es") {
  const out = renderNotification(variant, payload, { now: NOW, locale });
  const a = out.inApp!;
  if (locale === "es") {
    // Only the in-app text localizes: every other channel, the category and
    // the dedupe fingerprint are identical to English, for every case below.
    const en = renderNotification(variant, payload, { now: NOW, locale: "en" });
    expect(out.email).toEqual(en.email);
    expect(out.push).toEqual(en.push);
    expect(out.sms).toEqual(en.sms);
    expect(out.fingerprint).toEqual(en.fingerprint);
    expect(out.category).toEqual(en.category);
  }
  return { out, title: a.title, body: a.body, label: a.action?.label ?? null };
}

// ── applications ─────────────────────────────────────────────────────────────

const appBase = {
  eventId: U1,
  eventTitle: "Rooftop Showcase",
  submissionId: U2,
  eventUrl: "https://ithas.fire/e/rooftop-showcase",
};

describe("application notices (in-app copy)", () => {
  it("event.application-received", () => {
    const en = inApp("event.application-received", appBase, "en");
    expect(en.title).toBe("Application sent: Rooftop Showcase");
    expect(en.body).toBe(
      "Your spot isn't confirmed yet. We'll email you when the organizer decides.",
    );
    expect(en.label).toBe("View event");
    const es = inApp("event.application-received", appBase, "es");
    expect(es.title).toBe("Solicitud enviada: Rooftop Showcase");
    expect(es.body).toBe(
      "Tu cupo aún no está confirmado. Te enviaremos un correo cuando quien organiza decida.",
    );
    expect(es.label).toBe("Ver evento");
    // Email stays English whatever the in-app locale.
    expect(es.out.email?.subject).toBe("Application sent: Rooftop Showcase");
    expect(es.out.email?.text).toBe(en.out.email?.text);
  });

  it("event.application-received without an event page has no action", () => {
    const { eventUrl: _omit, ...noUrl } = appBase;
    for (const locale of ["en", "es"] as const) {
      expect(inApp("event.application-received", noUrl, locale).label).toBeNull();
    }
  });

  it("event.application-approved", () => {
    const payload = { ...appBase, approvalToken: "tok_abc" };
    const en = inApp("event.application-approved", payload, "en");
    expect(en.title).toBe("You're in: Rooftop Showcase");
    expect(en.body).toBe(
      "The organizer approved your application. The event page is open to you now.",
    );
    expect(en.label).toBe("View event");
    const es = inApp("event.application-approved", payload, "es");
    expect(es.title).toBe("Estás dentro: Rooftop Showcase");
    expect(es.body).toBe(
      "Quien organiza aprobó tu solicitud. La página del evento ya está abierta para ti.",
    );
    expect(es.label).toBe("Ver evento");
    expect(es.out.email?.subject).toBe("You're in: Rooftop Showcase");
  });

  it("event.application-rejected, with and without the reviewer's note", () => {
    const withNote = {
      eventId: U1,
      eventTitle: "Rooftop Showcase",
      submissionId: U2,
      decisionReason: "We're full this season",
    };
    const en = inApp("event.application-rejected", withNote, "en");
    expect(en.title).toBe("Not approved: Rooftop Showcase");
    expect(en.body).toBe(
      "The organizer didn't approve your application. Note from the organizer: We're full this season",
    );
    expect(en.label).toBeNull();
    const es = inApp("event.application-rejected", withNote, "es");
    expect(es.title).toBe("Solicitud no aprobada: Rooftop Showcase");
    // The note is the reviewer's own words: verbatim, never translated.
    expect(es.body).toBe(
      "Quien organiza no aprobó tu solicitud. Nota de quien organiza: We're full this season",
    );
    expect(es.label).toBeNull();

    const bare = { ...withNote, decisionReason: undefined };
    expect(inApp("event.application-rejected", bare, "en").body).toBe(
      "The organizer didn't approve your application.",
    );
    expect(inApp("event.application-rejected", bare, "es").body).toBe(
      "Quien organiza no aprobó tu solicitud.",
    );
    expect(es.out.email?.subject).toBe("Not approved: Rooftop Showcase");
  });

  it("event.application-waitlisted", () => {
    const en = inApp("event.application-waitlisted", appBase, "en");
    expect(en.title).toBe("Waitlisted: Rooftop Showcase");
    expect(en.body).toBe("If a spot opens, we'll email you a link.");
    expect(en.label).toBe("View event");
    const es = inApp("event.application-waitlisted", appBase, "es");
    expect(es.title).toBe("En lista de espera: Rooftop Showcase");
    expect(es.body).toBe(
      "Si se libera un cupo, te enviaremos un enlace por correo.",
    );
    expect(es.label).toBe("Ver evento");
    expect(es.out.email?.subject).toBe("Waitlisted: Rooftop Showcase");
  });

  it("event.application-back-in-review", () => {
    const en = inApp("event.application-back-in-review", appBase, "en");
    expect(en.title).toBe("Back in review: Rooftop Showcase");
    expect(en.body).toBe(
      "The organizer withdrew their approval. Your application is back in review.",
    );
    expect(en.label).toBe("View event");
    const es = inApp("event.application-back-in-review", appBase, "es");
    expect(es.title).toBe("De nuevo en revisión: Rooftop Showcase");
    expect(es.body).toBe(
      "Quien organiza retiró su aprobación. Tu solicitud vuelve a estar en revisión.",
    );
    expect(es.label).toBe("Ver evento");
    expect(es.out.email?.subject).toBe("Back in review: Rooftop Showcase");
  });
});

// ── lineup ───────────────────────────────────────────────────────────────────

const added = {
  eventId: U1,
  eventHumanId: U3,
  eventTitle: "Friday Night Sessions",
  startsAtIso: "2026-10-04T22:00:00.000Z",
  timezone: "America/Chicago",
  roleLabel: "Performer",
  addedByName: "Sam Rivera",
  lineupsUrl: "https://ithas.fire/my-lineups",
  publiclyListed: true,
  eventEnded: false,
  organiserWillBeTold: true,
};

const left = {
  eventId: U1,
  eventHumanId: U3,
  eventTitle: "Friday Night Sessions",
  startsAtIso: "2026-10-04T22:00:00.000Z",
  timezone: "America/Chicago",
  personName: "Jo Park",
  lineupUrl: "https://ithas.fire/admin/events/abc/edit?section=lineup",
  wasPubliclyListed: true,
};

describe("lineup notices (in-app copy)", () => {
  it("event.lineup-added", () => {
    const en = inApp("event.lineup-added", added, "en");
    expect(en.title).toBe("You're on the lineup for Friday Night Sessions");
    expect(en.body).toBe(
      "Sam Rivera added you as Performer. Sun, Oct 4, 5:00 PM.",
    );
    expect(en.label).toBe("Review your lineups");
    const es = inApp("event.lineup-added", added, "es");
    expect(es.title).toBe("Estás en el lineup de Friday Night Sessions");
    expect(es.body).toBe(
      "Sam Rivera te agregó como artista. Empieza el domingo 4 de octubre de 2026 a las 17:00 (GMT-5).",
    );
    expect(es.label).toBe("Revisar tus lineups");
    expect(es.out.inApp?.action).toMatchObject({ route: "/my-lineups" });
    // Push and email keep the English text.
    expect(es.out.push?.title).toBe(en.title);
    expect(es.out.push?.body).toBe(en.body);
    expect(es.out.email?.subject).toBe(en.title);
    expect(es.out.email?.text).toBe(en.out.email?.text);

    // An event that has already started says "Fue el", not "Empieza el".
    const ended = { ...added, eventEnded: true };
    expect(inApp("event.lineup-added", ended, "es").body).toBe(
      "Sam Rivera te agregó como artista. Fue el domingo 4 de octubre de 2026 a las 17:00 (GMT-5).",
    );
    expect(inApp("event.lineup-added", ended, "en").body).toBe(
      "Sam Rivera added you as Performer. Sun, Oct 4, 5:00 PM.",
    );
  });

  it("event.lineup-left, listed and unlisted", () => {
    const en = inApp("event.lineup-left", left, "en");
    expect(en.title).toBe("Jo Park took themselves off the lineup");
    expect(en.body).toBe(
      "Friday Night Sessions, Sun, Oct 4. Their name is off the event page.",
    );
    expect(en.label).toBe("Open the lineup");
    const es = inApp("event.lineup-left", left, "es");
    expect(es.title).toBe("Jo Park salió del lineup");
    expect(es.body).toBe(
      "Friday Night Sessions, domingo 4 de octubre de 2026. Su nombre ya no aparece en la página del evento.",
    );
    expect(es.label).toBe("Abrir el lineup");
    expect(es.out.inApp?.action).toMatchObject({ href: left.lineupUrl });
    expect(es.out.email?.subject).toBe(en.title);
    expect(es.out.email?.text).toBe(en.out.email?.text);

    const priv = { ...left, wasPubliclyListed: false };
    expect(inApp("event.lineup-left", priv, "en").body).toBe(
      "Friday Night Sessions, Sun, Oct 4. They're off the lineup.",
    );
    expect(inApp("event.lineup-left", priv, "es").body).toBe(
      "Friday Night Sessions, domingo 4 de octubre de 2026. Ya no está en el lineup.",
    );
  });
});

// ── bill notices ─────────────────────────────────────────────────────────────

const answeredBase = {
  bookingRequestId: U1,
  actId: U2,
  humanId: U4,
  actName: "Paper Moth",
  venueName: "The Corner Stage",
  targetUrl: "https://ithas.fire/admin/corner/bookings",
};

const closedBase = {
  bookingRequestId: U1,
  actId: U2,
  humanId: U4,
  senderName: "Corner Booking Collective",
  venueName: "The Corner Stage",
  targetUrl: "https://ithas.fire/bookings/acts/abc",
};

const removedBase = {
  bookingRequestId: U1,
  actId: U2,
  humanId: U4,
  senderName: "Corner Booking Collective",
  venueName: "The Corner Stage",
};

describe("bill notices (in-app copy)", () => {
  it("booking.lineup-answered: joined / passed / left", () => {
    const expected = {
      joined: {
        enTitle: "Paper Moth joined your bill at The Corner Stage",
        enBody: "The place now sees them as joined.",
        esTitle: "Paper Moth se sumó a tu lineup en The Corner Stage",
        esBody: "El lugar ya ve que se sumó.",
      },
      passed: {
        enTitle: "Paper Moth passed on your bill at The Corner Stage",
        enBody: "They're off the bill. The place doesn't see them on it.",
        esTitle: "Paper Moth no se sumará a tu lineup en The Corner Stage",
        esBody:
          "Ya no forma parte del lineup ni aparece en la solicitud que ve el lugar.",
      },
      left: {
        enTitle: "Paper Moth left your bill at The Corner Stage",
        enBody: "They're off the bill. The place doesn't see them on it.",
        esTitle: "Paper Moth salió de tu lineup en The Corner Stage",
        esBody:
          "Ya no forma parte del lineup ni aparece en la solicitud que ve el lugar.",
      },
    } as const;
    for (const answer of ["joined", "passed", "left"] as const) {
      const p = { ...answeredBase, answer };
      const en = inApp("booking.lineup-answered", p, "en");
      const es = inApp("booking.lineup-answered", p, "es");
      expect(en.title).toBe(expected[answer].enTitle);
      expect(en.body).toBe(expected[answer].enBody);
      expect(en.label).toBe("Open your bookings");
      expect(es.title).toBe(expected[answer].esTitle);
      expect(es.body).toBe(expected[answer].esBody);
      expect(es.label).toBe("Abrir tus contrataciones");
    }
  });

  it("booking.lineup-request-closed: solo act, group, with dates", () => {
    const en = inApp("booking.lineup-request-closed", closedBase, "en");
    expect(en.title).toBe("The request to The Corner Stage isn't going ahead");
    expect(en.body).toBe(
      "Corner Booking Collective's request to The Corner Stage, with you on the bill, isn't going ahead. There's nothing you need to do.",
    );
    expect(en.label).toBe("View the request");
    const es = inApp("booking.lineup-request-closed", closedBase, "es");
    expect(es.title).toBe(
      "La solicitud de contratación para The Corner Stage no seguirá adelante",
    );
    expect(es.body).toBe(
      "La solicitud de contratación de Corner Booking Collective para The Corner Stage, contigo en el lineup, no seguirá adelante. No tienes que hacer nada.",
    );
    expect(es.label).toBe("Ver la solicitud");
    // Email keeps English (subject and plain text).
    expect(es.out.email?.subject).toBe(en.title);
    expect(es.out.email?.text).toBe(en.out.email?.text);

    const group = {
      ...closedBase,
      asGroupName: "Paper Moth",
      preferredDates: ["2026-08-14T20:00", "2026-08-21"],
    };
    const enG = inApp("booking.lineup-request-closed", group, "en");
    expect(enG.body).toBe(
      "Corner Booking Collective's request to The Corner Stage for Fri, Aug 14, 2026 at 8:00 PM; Fri, Aug 21, 2026, with Paper Moth on the bill, isn't going ahead. There's nothing you need to do.",
    );
    const esG = inApp("booking.lineup-request-closed", group, "es");
    expect(esG.body).toBe(
      "La solicitud de contratación de Corner Booking Collective para The Corner Stage (fechas: viernes 14 de agosto de 2026 a las 20:00; viernes 21 de agosto de 2026), con Paper Moth en el lineup, no seguirá adelante. No tienes que hacer nada.",
    );
    const one = {
      ...closedBase,
      preferredDates: ["2026-08-14T01:30"],
    };
    expect(inApp("booking.lineup-request-closed", one, "es").body).toContain(
      "(fecha: viernes 14 de agosto de 2026 a la 1:30)",
    );
    // Email dates stay English.
    expect(esG.out.email?.template?.variables).toMatchObject({
      dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM", "Fri, Aug 21, 2026"],
    });
  });

  it("booking.lineup-removed: you, group, with dates", () => {
    const en = inApp("booking.lineup-removed", removedBase, "en");
    expect(en.title).toBe(
      "Corner Booking Collective took you off the bill at The Corner Stage",
    );
    expect(en.body).toBe(
      "Corner Booking Collective changed the bill they pitched to The Corner Stage, and you are no longer on it. There's nothing you need to do.",
    );
    expect(en.label).toBeNull();
    const es = inApp("booking.lineup-removed", removedBase, "es");
    expect(es.title).toBe(
      "Corner Booking Collective te quitó del lineup en The Corner Stage",
    );
    expect(es.body).toBe(
      "Corner Booking Collective cambió el lineup que propuso para The Corner Stage, y ya no formas parte de él. No tienes que hacer nada.",
    );
    expect(es.label).toBeNull();
    expect(es.out.email?.subject).toBe(en.title);
    expect(es.out.email?.text).toBe(en.out.email?.text);

    const group = {
      ...removedBase,
      asGroupName: "Paper Moth",
      preferredDates: ["2026-08-14"],
    };
    const enG = inApp("booking.lineup-removed", group, "en");
    expect(enG.title).toBe(
      "Corner Booking Collective took Paper Moth off the bill at The Corner Stage",
    );
    expect(enG.body).toBe(
      "Corner Booking Collective changed the bill they pitched to The Corner Stage for Fri, Aug 14, 2026, and Paper Moth is no longer on it. There's nothing you need to do.",
    );
    const esG = inApp("booking.lineup-removed", group, "es");
    expect(esG.title).toBe(
      "Corner Booking Collective quitó a Paper Moth del lineup en The Corner Stage",
    );
    expect(esG.body).toBe(
      "Corner Booking Collective cambió el lineup que propuso para The Corner Stage (fecha: viernes 14 de agosto de 2026), y Paper Moth ya no forma parte de él. No tienes que hacer nada.",
    );
  });
});
