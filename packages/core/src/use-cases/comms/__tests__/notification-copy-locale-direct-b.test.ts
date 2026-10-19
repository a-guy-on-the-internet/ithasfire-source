import { describe, expect, it } from "vitest";

import type { NotificationRecord } from "@th/ports/repos/notifications";

import type { NotificationLocale } from "../locale";
import { renderStoredNotification } from "../render-stored-notification";
import { renderNotification } from "../renderers";

/**
 * In-app copy, en and es, for the in-app-only variants whose producers write
 * their own inbox row (direct-community-renderers.ts): claim-venue notices,
 * the volunteer shift reminder, and community edit-suggestion notices.
 *
 * The English pins are exactly what the producers stored before these
 * variants existed (also pinned at each producer's own test).
 */

const NOW = new Date("2026-10-05T12:00:00Z");
const PLACE_ID = "c2000000-0000-4000-8000-000000000002";
const REQUEST_ID = "c3000000-0000-4000-8000-000000000003";

type Out = { title: string | null; body: string; label: string | null };

function inApp(
  variant: string,
  payload: unknown,
  locale: NotificationLocale,
): Out {
  const out = renderNotification(variant, payload, { now: NOW, locale });
  expect(out.email).toBeUndefined();
  expect(out.push).toBeUndefined();
  expect(out.sms).toBeUndefined();
  return {
    title: out.inApp!.title,
    body: out.inApp!.body,
    label: out.inApp!.action?.label ?? null,
  };
}

describe("place.claim-received", () => {
  const base = { placeId: PLACE_ID, placeName: "The Corner Stage", requestId: REQUEST_ID };

  it("claim", () => {
    const p = { ...base, source: "OWNERSHIP_CLAIM" };
    expect(inApp("place.claim-received", p, "en")).toEqual({
      title: "New place ownership claim",
      body: 'Someone claimed "The Corner Stage" and is awaiting review.',
      label: "Review claim",
    });
    expect(inApp("place.claim-received", p, "es")).toEqual({
      title: "Nueva reclamación de un lugar",
      body: 'Alguien reclamó «The Corner Stage» y está pendiente de revisión.',
      label: "Revisar reclamación",
    });
  });

  it("dispute", () => {
    const p = { ...base, source: "OWNERSHIP_DISPUTE" };
    expect(inApp("place.claim-received", p, "en")).toEqual({
      title: "New place ownership dispute",
      body: 'A dispute was filed against the verified owner of "The Corner Stage".',
      label: "Review claim",
    });
    expect(inApp("place.claim-received", p, "es")).toEqual({
      title: "Nueva disputa por un lugar",
      body: 'Se presentó una disputa sobre la propiedad verificada de «The Corner Stage».',
      label: "Revisar reclamación",
    });
  });
});

describe("place.claim-decided", () => {
  const base = { placeId: PLACE_ID, placeName: "The Corner Stage" };

  it("approved (a note is never shown)", () => {
    const p = { ...base, decision: "APPROVED", reviewerNotes: "hidden" };
    expect(inApp("place.claim-decided", p, "en")).toEqual({
      title: "Place claim approved",
      body: 'Your claim on "The Corner Stage" was approved — you now own this place.',
      label: "View place",
    });
    expect(inApp("place.claim-decided", p, "es")).toEqual({
      title: "Reclamación del lugar aprobada",
      body: 'Tu reclamación de «The Corner Stage» fue aprobada — ahora este lugar es tuyo.',
      label: "Ver lugar",
    });
  });

  it("rejected, with the reviewer's note verbatim", () => {
    const p = { ...base, decision: "REJECTED", reviewerNotes: "Proof didn't match." };
    expect(inApp("place.claim-decided", p, "en")).toEqual({
      title: "Place claim declined",
      body: 'Your claim on "The Corner Stage" was not approved. Reviewer note: Proof didn\'t match.',
      label: "View place",
    });
    expect(inApp("place.claim-decided", p, "es")).toEqual({
      title: "Reclamación del lugar no aprobada",
      body: 'Tu reclamación de «The Corner Stage» no fue aprobada. Nota de revisión: Proof didn\'t match.',
      label: "Ver lugar",
    });
  });

  it("rejected, no note", () => {
    const p = { ...base, decision: "REJECTED", reviewerNotes: null };
    expect(inApp("place.claim-decided", p, "en").body).toBe(
      'Your claim on "The Corner Stage" was not approved.',
    );
    expect(inApp("place.claim-decided", p, "es").body).toBe(
      'Tu reclamación de «The Corner Stage» no fue aprobada.',
    );
  });
});

describe("place.dispute-decided", () => {
  const base = { placeId: PLACE_ID, placeName: "The Corner Stage" };

  it("approved", () => {
    const p = { ...base, decision: "APPROVED", reviewerNotes: null };
    expect(inApp("place.dispute-decided", p, "en")).toEqual({
      title: "Ownership dispute approved",
      body: 'Your ownership dispute on "The Corner Stage" was approved — you now own this place.',
      label: "View place",
    });
    expect(inApp("place.dispute-decided", p, "es")).toEqual({
      title: "Disputa de propiedad aprobada",
      body: 'Tu disputa de propiedad sobre «The Corner Stage» fue aprobada — ahora este lugar es tuyo.',
      label: "Ver lugar",
    });
  });

  it("rejected, with a note", () => {
    const p = { ...base, decision: "REJECTED", reviewerNotes: "Lease expired." };
    expect(inApp("place.dispute-decided", p, "en")).toEqual({
      title: "Ownership dispute declined",
      body: 'Your ownership dispute on "The Corner Stage" was not approved. Reviewer note: Lease expired.',
      label: "View place",
    });
    expect(inApp("place.dispute-decided", p, "es")).toEqual({
      title: "Disputa de propiedad no aprobada",
      body: 'Tu disputa de propiedad sobre «The Corner Stage» no fue aprobada. Nota de revisión: Lease expired.',
      label: "Ver lugar",
    });
  });
});

describe("place.ownership-transferred / place.dispute-filed", () => {
  const p = { placeId: PLACE_ID, placeName: "The Corner Stage", requestId: REQUEST_ID };

  it("ownership transferred", () => {
    expect(inApp("place.ownership-transferred", p, "en")).toEqual({
      title: "Place ownership transferred",
      body: 'Following an ownership dispute review, your ownership of "The Corner Stage" was transferred to another party.',
      label: "View place",
    });
    expect(inApp("place.ownership-transferred", p, "es")).toEqual({
      title: "Propiedad del lugar transferida",
      body: 'Tras revisar una disputa de propiedad, tu propiedad de «The Corner Stage» se transfirió a otra parte.',
      label: "Ver lugar",
    });
  });

  it("dispute filed", () => {
    expect(inApp("place.dispute-filed", p, "en")).toEqual({
      title: "Ownership dispute filed",
      body: 'Someone filed a dispute contesting your ownership of "The Corner Stage". A platform admin will review it.',
      label: "View place",
    });
    expect(inApp("place.dispute-filed", p, "es")).toEqual({
      title: "Se presentó una disputa de propiedad",
      body: 'Alguien presentó una disputa sobre tu propiedad de «The Corner Stage». Nuestro equipo la revisará.',
      label: "Ver lugar",
    });
  });
});

describe("volunteer.shift-reminder-in-app", () => {
  const base = {
    signupId: "c4000000-0000-4000-8000-000000000004",
    eventId: "c5000000-0000-4000-8000-000000000005",
    eventTitle: "Summer Fest",
    roleName: "Security",
    manageUrl: "https://ithas.fire/volunteer?signup=c4000000-0000-4000-8000-000000000004",
  };

  it("24h, with a shift label", () => {
    const p = { ...base, shiftLabel: "Morning", kind: "REMINDER_24H" };
    expect(inApp("volunteer.shift-reminder-in-app", p, "en")).toEqual({
      title: "Reminder: your Summer Fest shift tomorrow",
      body: "Tomorrow — your Security shift (Morning) at Summer Fest.",
      label: "Open your signup",
    });
    expect(inApp("volunteer.shift-reminder-in-app", p, "es")).toEqual({
      title: "Recordatorio: tu turno de voluntariado en Summer Fest es mañana",
      body: "Mañana — tu turno de Security (Morning) en Summer Fest.",
      label: "Abrir tu inscripción",
    });
  });

  it("1h, no shift label", () => {
    const p = { ...base, shiftLabel: null, kind: "REMINDER_1H" };
    expect(inApp("volunteer.shift-reminder-in-app", p, "en")).toEqual({
      title: "Reminder: your Summer Fest shift in about an hour",
      body: "In about an hour — your Security shift at Summer Fest.",
      label: "Open your signup",
    });
    expect(inApp("volunteer.shift-reminder-in-app", p, "es")).toEqual({
      title: "Recordatorio: tu turno de voluntariado en Summer Fest empieza en aproximadamente una hora",
      body: "En aproximadamente una hora — tu turno de Security en Summer Fest.",
      label: "Abrir tu inscripción",
    });
  });

  it("keeps the absolute manage URL as the action href", () => {
    const out = renderNotification(
      "volunteer.shift-reminder-in-app",
      { ...base, shiftLabel: null, kind: "REMINDER_1H" },
      { now: NOW, locale: "es" },
    );
    expect(out.inApp!.action).toEqual({
      label: "Abrir tu inscripción",
      href: base.manageUrl,
    });
  });
});

describe("volunteer.start-reminder-in-app", () => {
  const ask = {
    signupId: "c4000000-0000-4000-8000-000000000004",
    anchor: "ASK_START",
    eventId: null,
    askId: "c7000000-0000-4000-8000-000000000007",
    title: "River cleanup day",
    roleName: "Litter picker",
    // 2026-10-06 09:00 in Chicago (CDT).
    startsAtIso: "2026-10-06T14:00:00.000Z",
    timezone: "America/Chicago",
    manageUrl: "https://ithas.fire/v/c7000000-0000-4000-8000-000000000007",
  };
  const event = {
    ...ask,
    anchor: "EVENT_START",
    eventId: "c5000000-0000-4000-8000-000000000005",
    askId: null,
    title: "Summer Fest",
    roleName: "Volunteer",
    manageUrl: "https://ithas.fire/events/summer-fest/volunteer?signup=c4000000-0000-4000-8000-000000000004",
  };

  it("ask, 24h: names what starts and when, never a shift", () => {
    const p = { ...ask, kind: "REMINDER_24H" };
    expect(inApp("volunteer.start-reminder-in-app", p, "en")).toEqual({
      title: "Reminder: River cleanup day starts tomorrow",
      body: "Tomorrow at 9:00 AM CDT — you're volunteering as Litter picker at River cleanup day.",
      label: "View details",
    });
    expect(inApp("volunteer.start-reminder-in-app", p, "es")).toEqual({
      title: "Recordatorio: River cleanup day empieza mañana",
      body: "Mañana, a las 9:00 (GMT-5) — tu voluntariado en River cleanup day como Litter picker.",
      label: "Ver detalles",
    });
  });

  it("event start, 1h, the stored 'Volunteer' fallback role reads as no role", () => {
    const p = { ...event, kind: "REMINDER_1H" };
    expect(inApp("volunteer.start-reminder-in-app", p, "en")).toEqual({
      title: "Reminder: Summer Fest starts in about an hour",
      body: "In about an hour at 9:00 AM CDT — you're volunteering at Summer Fest.",
      label: "Open your signup",
    });
    expect(inApp("volunteer.start-reminder-in-app", p, "es")).toEqual({
      title: "Recordatorio: Summer Fest empieza en aproximadamente una hora",
      body: "En aproximadamente una hora, a las 9:00 (GMT-5) — tu voluntariado en Summer Fest.",
      label: "Abrir tu inscripción",
    });
  });

  it("tags and metadata name the anchor's subject", () => {
    const out = renderNotification(
      "volunteer.start-reminder-in-app",
      { ...ask, kind: "REMINDER_1H" },
      { now: NOW, locale: "en" },
    );
    expect(out.inApp!.tags).toEqual(["volunteer", "ask", "reminder", "1h"]);
    expect(out.inApp!.metadata).toEqual({
      signupId: ask.signupId,
      askId: ask.askId,
      kind: "REMINDER_1H",
    });
    expect(out.inApp!.action).toEqual({
      label: "View details",
      href: ask.manageUrl,
    });
  });
});

describe("community.suggestion-received", () => {
  const base = {
    eventId: "c5000000-0000-4000-8000-000000000005",
    suggestionId: "c6000000-0000-4000-8000-000000000006",
    eventTitle: "Jazz Brunch",
  };

  it("community listing → moderator queue", () => {
    const p = { ...base, moderatorQueue: true };
    expect(inApp("community.suggestion-received", p, "en")).toEqual({
      title: "New edit suggestion",
      body: 'A visitor suggested changes to "Jazz Brunch".',
      label: "Review suggestion",
    });
    expect(inApp("community.suggestion-received", p, "es")).toEqual({
      title: "Nueva sugerencia de cambios",
      body: 'Alguien sugirió cambios en «Jazz Brunch».',
      label: "Revisar sugerencia",
    });
  });

  it("owned event → no action", () => {
    const p = { ...base, moderatorQueue: false };
    expect(inApp("community.suggestion-received", p, "es").label).toBeNull();
  });
});

describe("community.suggestion-reviewed", () => {
  const base = {
    eventId: "c5000000-0000-4000-8000-000000000005",
    suggestionId: "c6000000-0000-4000-8000-000000000006",
    eventTitle: "Jazz Brunch",
    eventRoute: "/events/jazz-brunch",
  };

  it("approved, skipped fields and a note (both verbatim)", () => {
    const p = {
      ...base,
      decision: "APPROVE",
      reviewNote: "Thanks!",
      conflictedFields: ["title", "startsAt"],
    };
    expect(inApp("community.suggestion-reviewed", p, "en")).toEqual({
      title: "Your suggestion was approved",
      body: 'Your suggested changes to "Jazz Brunch" were approved and applied. Some fields had changed since you submitted and were skipped: title, startsAt. Reviewer note: Thanks!',
      label: "View event",
    });
    expect(inApp("community.suggestion-reviewed", p, "es")).toEqual({
      title: "Tu sugerencia fue aprobada",
      body: 'Tus cambios sugeridos para «Jazz Brunch» se aprobaron y aplicaron. Algunos campos cambiaron después de que enviaste la sugerencia, así que se omitieron: title, startsAt. Nota de revisión: Thanks!',
      label: "Ver evento",
    });
  });

  it("approved, plain", () => {
    const p = { ...base, decision: "APPROVE", reviewNote: null, conflictedFields: [] };
    expect(inApp("community.suggestion-reviewed", p, "en").body).toBe(
      'Your suggested changes to "Jazz Brunch" were approved and applied.',
    );
    expect(inApp("community.suggestion-reviewed", p, "es").body).toBe(
      'Tus cambios sugeridos para «Jazz Brunch» se aprobaron y aplicaron.',
    );
  });

  it("rejected, with a note", () => {
    const p = { ...base, decision: "REJECT", reviewNote: "Not accurate.", conflictedFields: [] };
    expect(inApp("community.suggestion-reviewed", p, "en")).toEqual({
      title: "Your suggestion was reviewed",
      body: 'Your suggested changes to "Jazz Brunch" were reviewed but not applied. Reviewer note: Not accurate.',
      label: "View event",
    });
    expect(inApp("community.suggestion-reviewed", p, "es")).toEqual({
      title: "Tu sugerencia fue revisada",
      body: 'Tus cambios sugeridos para «Jazz Brunch» se revisaron, pero no se aplicaron. Nota de revisión: Not accurate.',
      label: "Ver evento",
    });
  });

  it("no public page → no action", () => {
    const p = { ...base, eventRoute: null, decision: "REJECT", reviewNote: null, conflictedFields: [] };
    expect(inApp("community.suggestion-reviewed", p, "es").label).toBeNull();
  });
});

describe("a directly written row re-renders in the inbox", () => {
  it("swaps title, body and label; keeps the stored route", () => {
    const row = {
      id: "n1",
      title: "Ownership dispute filed",
      body: 'Someone filed a dispute contesting your ownership of "The Corner Stage". A platform admin will review it.',
      action: { label: "View venue", route: `/places/id/${PLACE_ID}` },
      metadata: { placeId: PLACE_ID, requestId: REQUEST_ID, variant: "place.dispute-filed" },
      templateKey: "place.dispute-filed",
      templateVersion: "1",
      templateVariables: { placeId: PLACE_ID, placeName: "The Corner Stage", requestId: REQUEST_ID },
      createdAt: NOW,
    } satisfies Partial<NotificationRecord>;

    const es = renderStoredNotification({}, row, "es");
    expect(es.title).toBe("Se presentó una disputa de propiedad");
    expect(es.body).toBe(
      'Alguien presentó una disputa sobre tu propiedad de «The Corner Stage». Nuestro equipo la revisará.',
    );
    expect(es.action).toEqual({ label: "Ver lugar", route: `/places/id/${PLACE_ID}` });
    expect(renderStoredNotification({}, row, "en")).toBe(row);
  });
});
