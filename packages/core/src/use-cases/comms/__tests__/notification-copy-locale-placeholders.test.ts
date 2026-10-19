import { describe, expect, it } from "vitest";

import { localizePlaceholderName } from "../copy/common";
import { esLineupRoleClause } from "../copy/lineup";
import { renderNotification } from "../renderers";

// Producers store an English fallback word ("The place", "Someone", "a place",
// ...; the full list is in copy/common.ts) in a payload when no name resolved,
// and the lineup producer stores the English built-in role label. Payloads are
// re-rendered at read time, so Spanish maps them in the copy layer. English
// prints them exactly as stored.

const NOW = new Date("2026-08-01T12:00:00Z");
const REQ = "11111111-0000-4000-8000-000000000001";
const HOLD = "22222222-0000-4000-8000-000000000002";
const ASK = "33333333-0000-4000-8000-000000000003";
const URL = "https://ithas.fire/account/settings/booking-requests";

const inApp = (
  variant: string,
  payload: Record<string, unknown>,
  locale: "en" | "es",
) => {
  const out = renderNotification(variant, payload, { now: NOW, locale }).inApp;
  return { title: out!.title, body: out!.body };
};

const holdBase = {
  bookingRequestId: REQ,
  holdId: HOLD,
  placeName: "The place",
  date: "2026-08-14",
  timezone: "America/Chicago",
  targetUrl: URL,
};

describe("localizePlaceholderName", () => {
  it("leaves English and real names verbatim", () => {
    expect(localizePlaceholderName("en", "The place")).toBe("The place");
    expect(localizePlaceholderName("en", "The act", "mid")).toBe("The act");
    expect(localizePlaceholderName("es", "The Hall")).toBe("The Hall");
  });
  it.each([
    ["Someone", "Alguien", "alguien", "a alguien", "de alguien"],
    ["a place", "Un lugar", "un lugar", "a un lugar", "de un lugar"],
    ["A performer", "Alguien", "alguien", "a alguien", "de alguien"],
    ["An artist", "Alguien", "alguien", "a alguien", "de alguien"],
    ["Performer", "Alguien", "alguien", "a alguien", "de alguien"],
    [
      "Your booking contact",
      "Tu contacto de contratación",
      "tu contacto de contratación",
      "a tu contacto de contratación",
      "de tu contacto de contratación",
    ],
    [
      "An organizer",
      "Alguien que organiza eventos",
      "alguien que organiza eventos",
      "a alguien que organiza eventos",
      "de alguien que organiza eventos",
    ],
    [
      "The organiser",
      "Quien organiza",
      "quien organiza",
      "a quien organiza",
      "de quien organiza",
    ],
    ["Your event", "Tu evento", "tu evento", "a tu evento", "de tu evento"],
  ])("maps the fallback %s in Spanish at every position", (word, start, mid, a, de) => {
    expect(localizePlaceholderName("es", word, "start")).toBe(start);
    expect(localizePlaceholderName("es", word, "mid")).toBe(mid);
    expect(localizePlaceholderName("es", word, "a")).toBe(a);
    expect(localizePlaceholderName("es", word, "de")).toBe(de);
    expect(localizePlaceholderName("en", word, "de")).toBe(word);
  });
  it("maps the sentinels in Spanish by position", () => {
    expect(localizePlaceholderName("es", "The place", "start")).toBe("El lugar");
    expect(localizePlaceholderName("es", "The place", "mid")).toBe("el lugar");
    expect(localizePlaceholderName("es", "The place", "a")).toBe("al lugar");
    expect(localizePlaceholderName("es", "The place", "de")).toBe("del lugar");
    expect(localizePlaceholderName("es", "The act", "start")).toBe(
      "Quien envió la solicitud",
    );
    expect(localizePlaceholderName("es", "The act", "de")).toBe(
      "de quien envió la solicitud",
    );
  });
  // Producers stored "The venue" / "a venue" before copy moved to "place"
  // (2026-10-17). Those rows are re-rendered at read time, so they must keep
  // translating.
  it("still maps the fallbacks stored before the venue → place rename", () => {
    expect(localizePlaceholderName("es", "The venue", "start")).toBe("El lugar");
    expect(localizePlaceholderName("es", "The venue", "mid")).toBe("el lugar");
    expect(localizePlaceholderName("es", "The venue", "a")).toBe("al lugar");
    expect(localizePlaceholderName("es", "The venue", "de")).toBe("del lugar");
    expect(localizePlaceholderName("es", "a venue", "start")).toBe("Un lugar");
    expect(localizePlaceholderName("es", "a venue", "de")).toBe("de un lugar");
    expect(localizePlaceholderName("en", "The venue")).toBe("The venue");
  });
});

describe("stored placeholder names (in-app copy)", () => {
  it("booking.hold-placed: venue sentinel", () => {
    const p = { ...holdBase, position: 2 };
    expect(inApp("booking.hold-placed", p, "en").title).toBe(
      "The place is holding Fri, Aug 14, 2026 for you",
    );
    expect(inApp("booking.hold-placed", p, "es").title).toBe(
      "El lugar creó una reserva para ti el viernes 14 de agosto de 2026",
    );
  });

  it("a row stored with the old fallbacks still renders in Spanish", () => {
    const hold = { ...holdBase, placeName: "The venue", position: 2 };
    expect(inApp("booking.hold-placed", hold, "es").title).toBe(
      "El lugar creó una reserva para ti el viernes 14 de agosto de 2026",
    );
    const invite = {
      bookingRequestId: REQ,
      humanId: "10000000-0000-4000-8000-000000000001",
      senderName: "Someone",
      venueName: "a venue",
      preferredDates: [] as string[],
      targetUrl: URL,
    };
    expect(inApp("booking.lineup-invited", invite, "es").title).toBe(
      "Alguien te sumó a un lineup en un lugar",
    );
  });

  it("booking.hold-position-changed and -challenged: venue mid-sentence and after a preposition", () => {
    const moved = inApp(
      "booking.hold-position-changed",
      { ...holdBase, position: 2 },
      "es",
    );
    expect(moved.body).toContain("Tu reserva en el lugar es ahora");
    const challenged = inApp(
      "booking.hold-challenged",
      {
        ...holdBase,
        position: 1,
        respondByISO: "2026-08-12T23:00:00.000Z",
        keepWill: "book_now",
      },
      "es",
    );
    expect(challenged.title).toMatch(/^El lugar necesita tu respuesta sobre/);
  });

  it("booking.hold-challenge-answered (staff): act sentinel at the start", () => {
    const p = {
      ...holdBase,
      audience: "staff",
      answer: "kept",
      actName: "The act",
    };
    expect(inApp("booking.hold-challenge-answered", p, "en").title).toMatch(
      /^The act kept their hold on/,
    );
    expect(inApp("booking.hold-challenge-answered", p, "es").title).toMatch(
      /^Quien envió la solicitud mantuvo su reserva del /,
    );
  });

  it("booking.hold-expired (staff): act sentinel after 'de'", () => {
    const p = { ...holdBase, audience: "staff", actName: "The act" };
    expect(inApp("booking.hold-expired", p, "es").title).toMatch(
      /^Venció la reserva de quien envió la solicitud del /,
    );
  });

  it("booking.ask-received: venue sentinel", () => {
    const p = {
      bookingRequestId: REQ,
      askId: ASK,
      venueName: "The place",
      kind: "FILE",
      label: "Stage plot",
      targetUrl: URL,
    };
    expect(inApp("booking.ask-received", p, "en").title).toBe(
      "The place asked you for: Stage plot",
    );
    expect(inApp("booking.ask-received", p, "es").title).toBe(
      "El lugar te pidió: Stage plot",
    );
  });

  it("booking.ask-answered: act sentinel", () => {
    const p = {
      bookingRequestId: REQ,
      askId: ASK,
      answeredByName: "The act",
      kind: "FILE",
      label: "Stage plot",
      targetUrl: URL,
    };
    expect(inApp("booking.ask-answered", p, "en").title).toBe(
      "The act answered: Stage plot",
    );
    expect(inApp("booking.ask-answered", p, "es").title).toBe(
      "Quien envió la solicitud respondió: Stage plot",
    );
  });

  // ── booking-request / venue-confirmation producers ────────────────────────

  const responded = (action: string) => ({
    bookingRequestId: REQ,
    responderName: "The place",
    action,
    targetUrl: URL,
  });

  it("booking.request-responded: venue sentinel at the start, every action", () => {
    expect(inApp("booking.request-responded", responded("accepted"), "en").title).toBe(
      "The place accepted your booking request",
    );
    expect(inApp("booking.request-responded", responded("accepted"), "es").title).toBe(
      "El lugar aceptó tu solicitud de contratación",
    );
    expect(inApp("booking.request-responded", responded("declined"), "es").title).toBe(
      "El lugar rechazó tu solicitud de contratación",
    );
    expect(inApp("booking.request-responded", responded("closed"), "es").title).toBe(
      "El lugar cerró tu solicitud de contratación",
    );
  });

  it.each([
    ["venue", "The place", "El lugar"],
    ["sender", "The act", "Quien envió la solicitud"],
    ["sender", "Someone", "Alguien"],
    ["sender", "Performer", "Alguien"],
  ])("booking.booking-cancelled (%s): %s at the start", (by, name, es) => {
    const p = {
      bookingRequestId: REQ,
      cancelledByName: name,
      cancelledBy: by,
      date: "2026-08-14",
      reason: "Flood.",
      eventCancelled: false,
      targetUrl: URL,
    };
    expect(inApp("booking.booking-cancelled", p, "en").title).toMatch(
      new RegExp(`^${name} cancelled the booking for `),
    );
    expect(inApp("booking.booking-cancelled", p, "es").title).toMatch(
      new RegExp(`^${es} canceló la contratación del `),
    );
  });

  const confirm = {
    eventId: "e1000000-0000-4000-8000-000000000001",
    eventTitle: "Your event",
    placeId: "e2000000-0000-4000-8000-000000000002",
    placeName: "The place",
    bookingRequestId: "e3000000-0000-4000-8000-000000000003",
    targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
  };

  it("event.venue-confirmed: venue at the start, event title mid-sentence", () => {
    expect(inApp("event.venue-confirmed", confirm, "en").title).toBe(
      "The place confirmed Your event",
    );
    expect(inApp("event.venue-confirmed", confirm, "es").title).toBe(
      "El lugar confirmó tu evento",
    );
  });

  it("event.venue-confirmation-withdrawn: venue at the start, event title after 'de'", () => {
    const p = { ...confirm, reason: "Double-booked." };
    expect(inApp("event.venue-confirmation-withdrawn", p, "en").title).toBe(
      "The place withdrew its confirmation of Your event",
    );
    expect(inApp("event.venue-confirmation-withdrawn", p, "es").title).toBe(
      "El lugar retiró su confirmación de tu evento",
    );
    expect(
      inApp(
        "event.venue-confirmation-withdrawn",
        { ...p, placeName: "The Hall", eventTitle: "Night Market" },
        "es",
      ).title,
    ).toBe("The Hall retiró su confirmación de Night Market");
  });

  // ── bill notices: "Someone", "a place", "An artist" ───────────────────────

  const bill = {
    bookingRequestId: REQ,
    actId: "9f7c4384-a0b1-4c23-9de5-5a6b7c8d9e0f",
    humanId: "10000000-0000-4000-8000-000000000001",
    senderName: "Someone",
    venueName: "a place",
    preferredDates: [] as string[],
  };

  it("booking.lineup-invited: sender at the start, venue mid and after 'a'", () => {
    const { actId: _actId, ...invite } = bill;
    const p = { ...invite, targetUrl: URL };
    expect(inApp("booking.lineup-invited", p, "en").title).toBe(
      "Someone added you to a bill at a place",
    );
    const es = inApp("booking.lineup-invited", p, "es");
    expect(es.title).toBe("Alguien te sumó a un lineup en un lugar");
    expect(es.body).toMatch(/^Le propuso a un lugar un lineup contigo\./);
    const group = inApp(
      "booking.lineup-invited",
      { ...p, asGroupName: "Paper Moth" },
      "es",
    );
    expect(group.title).toBe("Alguien sumó a Paper Moth a un lineup en un lugar");
    expect(group.body).toMatch(/^Le propuso a un lugar un lineup con Paper Moth\./);
    // A real venue keeps its own "a".
    expect(
      inApp("booking.lineup-invited", { ...p, venueName: "The Hall" }, "es").body,
    ).toMatch(/^Le propuso a The Hall un lineup contigo\./);
  });

  it("booking.lineup-removed: sender at the start, venue mid", () => {
    const es = inApp("booking.lineup-removed", bill, "es");
    expect(es.title).toBe("Alguien te quitó del lineup en un lugar");
    expect(es.body).toBe(
      "Alguien cambió el lineup que propuso para un lugar, y ya no formas parte de él. No tienes que hacer nada.",
    );
  });

  it("booking.lineup-request-closed: sender after 'de', venue mid", () => {
    const p = { ...bill, targetUrl: URL };
    const es = inApp("booking.lineup-request-closed", p, "es");
    expect(es.title).toBe(
      "La solicitud de contratación para un lugar no seguirá adelante",
    );
    expect(es.body).toBe(
      "La solicitud de contratación de alguien para un lugar, contigo en el lineup, no seguirá adelante. No tienes que hacer nada.",
    );
  });

  it.each([
    ["joined", "Alguien se sumó a tu lineup en un lugar"],
    ["passed", "Alguien no se sumará a tu lineup en un lugar"],
    ["left", "Alguien salió de tu lineup en un lugar"],
  ])("booking.lineup-answered (%s): An artist + a place", (answer, es) => {
    const p = {
      bookingRequestId: REQ,
      actId: bill.actId,
      humanId: bill.humanId,
      actName: "An artist",
      venueName: "a place",
      answer,
      targetUrl: URL,
    };
    expect(inApp("booking.lineup-answered", p, "en").title).toMatch(
      /^An artist .* at a place$/,
    );
    expect(inApp("booking.lineup-answered", p, "es").title).toBe(es);
  });

  // ── request / message / organizer fallbacks ───────────────────────────────

  it("booking.request-received: 'A performer' at the start", () => {
    const p = {
      bookingRequestId: REQ,
      placeId: "a2000000-0000-4000-8000-000000000002",
      placeName: "The Corner Stage",
      actName: "A performer",
      contactName: null,
      contactEmail: null,
      message: "Hi.",
      preferredDates: [],
      source: "PLATFORM",
      inboxUrl: URL,
    };
    expect(inApp("booking.request-received", p, "en").body).toBe(
      "A performer wants to play The Corner Stage.",
    );
    expect(inApp("booking.request-received", p, "es").body).toBe(
      "Alguien quiere tocar en The Corner Stage.",
    );
  });

  it("booking.message-received: 'Your booking contact' after 'de'", () => {
    const p = {
      bookingRequestId: REQ,
      messageId: "a5000000-0000-4000-8000-000000000005",
      senderLabel: "Your booking contact",
      preview: "See you at 6.",
      threadUrl: URL,
    };
    expect(inApp("booking.message-received", p, "en").title).toBe(
      "New message from Your booking contact",
    );
    expect(inApp("booking.message-received", p, "es").title).toBe(
      "Nuevo mensaje de tu contacto de contratación",
    );
    expect(
      inApp("booking.message-received", { ...p, senderLabel: "Paper Moth" }, "es")
        .title,
    ).toBe("Nuevo mensaje de Paper Moth");
  });

  it("booking.organizer-request-received: 'An organizer' at the start", () => {
    const p = {
      bookingRequestId: REQ,
      orgName: "An organizer",
      message: "Hi.",
      preferredDates: [],
      requestsUrl: URL,
    };
    expect(inApp("booking.organizer-request-received", p, "en").title).toBe(
      "An organizer wants to book you",
    );
    const es = inApp("booking.organizer-request-received", p, "es");
    expect(es.title).toBe("Alguien que organiza eventos quiere contratarte");
    expect(es.body).toMatch(
      /^Alguien que organiza eventos te envió una solicitud de contratación\./,
    );
    expect(
      inApp(
        "booking.organizer-request-received",
        { ...p, attachedEventTitle: "Sunset Sessions" },
        "es",
      ).body,
    ).toMatch(/^Alguien que organiza eventos te pide tocar en Sunset Sessions\./);
  });

  // ── lineup notices ────────────────────────────────────────────────────────

  const added = {
    eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
    eventHumanId: "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b",
    eventTitle: "Friday Night Sessions",
    startsAtIso: "2026-11-14T01:30:00.000Z",
    timezone: "America/Chicago",
    roleLabel: "Performer",
    addedByName: "Someone",
    lineupsUrl: "https://ithas.fire/my-lineups",
    publiclyListed: true,
    eventEnded: false,
    organiserWillBeTold: true,
  };

  it("event.lineup-added: 'Someone' and 'The organiser' at the start", () => {
    expect(inApp("event.lineup-added", added, "en").body).toMatch(
      /^Someone added you as Performer\. /,
    );
    expect(inApp("event.lineup-added", added, "es").body).toMatch(
      /^Alguien te agregó como artista\. Empieza el /,
    );
    expect(
      inApp("event.lineup-added", { ...added, addedByName: "The organiser" }, "es")
        .body,
    ).toMatch(/^Quien organiza te agregó como artista\. /);
  });

  it("event.lineup-added: the built-in 'Other' role drops the 'como' clause in Spanish", () => {
    const p = { ...added, addedByName: "Sam Rivera", roleLabel: "Other" };
    expect(inApp("event.lineup-added", p, "en").body).toMatch(
      /^Sam Rivera added you as Other\. /,
    );
    expect(inApp("event.lineup-added", p, "es").body).toMatch(
      /^Sam Rivera te agregó al lineup\. Empieza el /,
    );
    // A custom label that merely contains "Other" keeps the clause.
    expect(
      inApp("event.lineup-added", { ...p, roleLabel: "Other acts" }, "es").body,
    ).toMatch(/^Sam Rivera te agregó como Other acts\. /);
  });

  it("event.lineup-left: 'Someone' at the start", () => {
    const p = {
      eventId: added.eventId,
      eventHumanId: added.eventHumanId,
      eventTitle: "Friday Night Sessions",
      startsAtIso: "2026-11-14T01:30:00.000Z",
      personName: "Someone",
      lineupUrl: "https://ithas.fire/admin/events/x/edit?section=lineup",
      wasPubliclyListed: false,
    };
    expect(inApp("event.lineup-left", p, "en").title).toBe(
      "Someone took themselves off the lineup",
    );
    expect(inApp("event.lineup-left", p, "es").title).toBe("Alguien salió del lineup");
  });

  it("event.application-submission-received: 'Someone' at the start", () => {
    const p = {
      eventId: "e1000000-0000-4000-8000-000000000001",
      eventTitle: "Night Market Sessions",
      submissionId: "e5000000-0000-4000-8000-000000000005",
      applicantName: "Someone",
      queueUrl: "https://ithas.fire/admin/@sam/events/night-market/applications",
    };
    expect(inApp("event.application-submission-received", p, "en").body).toBe(
      "Someone applied to Night Market Sessions.",
    );
    expect(inApp("event.application-submission-received", p, "es").body).toBe(
      "Alguien envió una solicitud para Night Market Sessions.",
    );
  });

  it("a real name is untouched in Spanish", () => {
    const p = { ...holdBase, placeName: "The Hall", position: 2 };
    expect(inApp("booking.hold-placed", p, "es").title).toMatch(/^The Hall creó/);
  });

});

describe("lineup role clauses (Spanish)", () => {
  it.each([
    ["Performer", "como artista"],
    ["Host", "a cargo de la conducción"],
    ["DJ", "como DJ"],
    ["Instructor", "como docente"],
    ["Speaker", "como ponente"],
    ["Vendor", "como comerciante"],
    ["Volunteer", "para el voluntariado"],
    ["Other", ""],
  ])("%s -> %s", (en, es) => {
    expect(esLineupRoleClause(en)).toBe(es);
  });

  it("puts an organizer's custom label verbatim after \"como\"", () => {
    expect(esLineupRoleClause("Fire spinner")).toBe("como Fire spinner");
    expect(esLineupRoleClause("toString")).toBe("como toString");
  });
});

describe("volunteer role fallback (\"Volunteer\" when the role row is missing)", () => {
  it("es says the role in Spanish; en and real role names stay verbatim", async () => {
    const { esVolunteerRole } = await import("../copy/common");
    const {
      VOLUNTEER_SIGNUP_APPROVED_COPY,
      VOLUNTEER_SIGNUP_REJECTED_COPY,
      VOLUNTEER_OCCURRENCE_CANCELLED_COPY,
      VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY,
    } = await import("../copy/volunteer-signups");
    const { VOLUNTEER_SHIFT_REMINDER_COPY } = await import("../copy/volunteering");

    expect(esVolunteerRole("Volunteer")).toBe("voluntariado");
    expect(esVolunteerRole("Security")).toBe("Security");

    expect(
      VOLUNTEER_SIGNUP_APPROVED_COPY.es.body({ eventTitle: "Summer Fest", roleName: "Volunteer" }),
    ).toBe("Tu inscripción de voluntariado en Summer Fest fue aprobada.");
    expect(
      VOLUNTEER_SIGNUP_APPROVED_COPY.en.body({ eventTitle: "Summer Fest", roleName: "Volunteer" }),
    ).toBe("You're approved to volunteer at Summer Fest as Volunteer.");
    expect(
      VOLUNTEER_SIGNUP_REJECTED_COPY.es.body({ eventTitle: "Summer Fest", roleName: "Volunteer" }),
    ).toBe("Gracias por tu interés en el voluntariado de Summer Fest. Esta vez tu inscripción no fue aprobada.");
    expect(
      VOLUNTEER_SIGNUP_REJECTED_COPY.es.body({ eventTitle: "Summer Fest", roleName: "Security" }),
    ).toBe("Gracias por tu interés en el voluntariado de Summer Fest como Security. Esta vez tu inscripción no fue aprobada.");
    expect(
      VOLUNTEER_OCCURRENCE_CANCELLED_COPY.es.title({ roleName: "Volunteer", askTitle: "Crew" }),
    ).toBe("Tu turno de voluntariado en Crew fue cancelado");
    expect(
      VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY.es.body({
        volunteerName: "Alex Kim",
        roleName: "Volunteer",
        groupName: "Setup",
        askTitle: "Crew",
      }),
    ).toBe("Se asignó a Alex Kim (voluntariado) a tu grupo Setup en Crew.");
    expect(
      VOLUNTEER_SHIFT_REMINDER_COPY.es.body({
        eventTitle: "Summer Fest",
        roleName: "Volunteer",
        shiftLabel: null,
        kind: "REMINDER_24H",
      }),
    ).toContain("tu turno de voluntariado en Summer Fest");
  });
});

describe("lineup-added es sentence per role", () => {
  it("reads naturally for a clause role and drops the clause for Other", async () => {
    const { LINEUP_ADDED_COPY } = await import("../copy/lineup");
    const base = { addedByName: "Sam", when: null, eventEnded: false } as const;
    expect(LINEUP_ADDED_COPY.es.body({ ...base, roleLabel: "Host" } as never)).toBe(
      "Sam te agregó a cargo de la conducción.",
    );
    expect(LINEUP_ADDED_COPY.es.body({ ...base, roleLabel: "Volunteer" } as never)).toBe(
      "Sam te agregó para el voluntariado.",
    );
    expect(LINEUP_ADDED_COPY.es.body({ ...base, roleLabel: "Other" } as never)).toBe(
      "Sam te agregó al lineup.",
    );
  });
});
