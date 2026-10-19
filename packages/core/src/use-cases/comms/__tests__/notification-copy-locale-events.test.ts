import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// Pins the exact in-app text (title / body / action label) of the event,
// moderation, venue-confirmation, review-prompt, setup and follow notices in
// every locale. English is what rows store and what email and push keep
// saying; it must not move. Organizer/user free text (event titles, names,
// addresses, reasons) stays verbatim in every locale.

const NOW = new Date("2026-11-01T12:00:00Z");
const E = "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const P = "4a2d9e3f-5c6b-4d7e-8f90-0b1c2d3e4f5a";
const S = "5b3e0f40-6d7c-4e8f-9fa1-1c2d3e4f5a6b";
const R = "6c4f1051-7e8d-4f90-8ab2-2d3e4f5a6b7c";
const EVENT_URL = "https://ithas.fire/e/night-market";

function inApp(variant: string, payload: unknown, locale: "en" | "es") {
  const out = renderNotification(variant, payload, { now: NOW, locale });
  const a = out.inApp!;
  if (locale === "es") {
    // Only the in-app text localizes: every other channel, the category and
    // the dedupe fingerprint are identical to English.
    const en = renderNotification(variant, payload, { now: NOW, locale: "en" });
    expect(out.email).toEqual(en.email);
    expect(out.push).toEqual(en.push);
    expect(out.sms).toEqual(en.sms);
    expect(out.fingerprint).toEqual(en.fingerprint);
    expect(out.category).toEqual(en.category);
    // Same kind, same route, same tags: only words change.
    expect(a.kind).toEqual(en.inApp!.kind);
    expect(a.tags).toEqual(en.inApp!.tags);
    expect({ ...a.action, label: "" }).toEqual({
      ...en.inApp!.action,
      label: "",
    });
  }
  // ICU may put a narrow no-break space before AM/PM; compare on plain spaces.
  const body = a.body?.replace(/[\u202f\u00a0]/gu, " ") ?? a.body;
  return { title: a.title, body, label: a.action?.label ?? null };
}

type Pin = { title: string; body: string; label: string | null };
type Case = {
  name: string;
  variant: string;
  payload: unknown;
  en: Pin;
  es: Pin;
};

const MOD_BASE = {
  recordId: S,
  kind: "EVENT_HERO",
  subjectType: "EVENT",
  subjectId: E,
  imageUrl: null,
  subjectTitle: "Night Market Sessions",
  subjectUrl: EVENT_URL,
  helpUrl: "https://ithas.fire/help",
};

const VENUE_BASE = {
  eventId: E,
  eventTitle: "Night Market Sessions",
  placeId: P,
  placeName: "The Hall",
  bookingRequestId: null,
  targetUrl: "https://ithas.fire/admin/@sam/events/night-market",
};

const NM = "Night Market Sessions";
const START = "2026-11-14T01:30:00.000Z";

const CASES: readonly Case[] = [
  {
    name: "entity.new-event",
    variant: "entity.new-event",
    payload: {
      entityPageId: P,
      entityName: "The Hall",
      eventId: E,
      eventTitle: NM,
      startsAtIso: START,
      timezone: "America/Chicago",
      eventUrl: EVENT_URL,
      manageFollowingUrl: "https://ithas.fire/following",
    },
    en: {
      title: "New event from The Hall",
      body: `${NM} — Fri, Nov 13, 2026, 7:30 PM CST.`,
      label: "View event",
    },
    es: {
      title: "Nuevo evento de The Hall",
      body: `${NM} — viernes 13 de noviembre de 2026 a las 19:30 (GMT-6).`,
      label: "Ver evento",
    },
  },
  {
    name: "event.application-submission-received",
    variant: "event.application-submission-received",
    payload: {
      eventId: E,
      eventTitle: NM,
      submissionId: S,
      applicantName: "Ana Ruiz",
      queueUrl: "https://ithas.fire/admin/@sam/events/night-market/applications",
    },
    en: {
      title: `New application for ${NM}`,
      body: `Ana Ruiz applied to ${NM}.`,
      label: "Review applications",
    },
    es: {
      title: `Nueva solicitud para ${NM}`,
      body: `Ana Ruiz envió una solicitud para ${NM}.`,
      label: "Revisar solicitudes",
    },
  },
  {
    name: "event.attendee-feedback-request (organizer, link)",
    variant: "event.attendee-feedback-request",
    payload: {
      eventId: E,
      eventTitle: NM,
      eventEndsAtIso: START,
      organizerName: "The Hall",
      orderId: S,
      requestId: R,
      feedbackUrl: "https://ithas.fire/feedback/abc",
    },
    en: {
      title: `How was ${NM}?`,
      body: `Tell us about your experience at ${NM} hosted by The Hall.`,
      label: "Leave feedback",
    },
    es: {
      title: `¿Qué tal estuvo ${NM}?`,
      body: `Cuéntanos cómo te fue en ${NM}, a cargo de The Hall.`,
      label: "Dejar comentarios",
    },
  },
  {
    name: "event.attendee-feedback-request (no organizer, no link)",
    variant: "event.attendee-feedback-request",
    payload: { eventId: E, eventTitle: NM, orderId: S, requestId: R },
    en: {
      title: `How was ${NM}?`,
      body: `Tell us about your experience at ${NM}.`,
      label: null,
    },
    es: {
      title: `¿Qué tal estuvo ${NM}?`,
      body: `Cuéntanos cómo te fue en ${NM}.`,
      label: null,
    },
  },
  {
    name: "event.cancelled (refunded)",
    variant: "event.cancelled",
    payload: {
      eventId: E,
      eventTitle: NM,
      startsAt: START,
      refund: { status: "refunded", amountCents: 2500, currency: "usd" },
      eventUrl: EVENT_URL,
    },
    en: {
      title: "Event cancelled — refund on the way",
      body: `${NM} has been cancelled. You've been refunded $25.00.`,
      label: "View event",
    },
    es: {
      title: "Evento cancelado — reembolso en camino",
      body: `Se canceló ${NM}. Te reembolsamos $25.00.`,
      label: "Ver evento",
    },
  },
  {
    name: "event.cancelled (refund pending)",
    variant: "event.cancelled",
    payload: {
      eventId: E,
      eventTitle: NM,
      startsAt: START,
      refund: { status: "pending" },
      eventUrl: EVENT_URL,
    },
    en: {
      title: "Event cancelled — refund in progress",
      body: `${NM} has been cancelled. Your refund is being processed and we'll follow up.`,
      label: "View event",
    },
    es: {
      title: "Evento cancelado — reembolso en proceso",
      body: `Se canceló ${NM}. Estamos procesando tu reembolso y te avisaremos.`,
      label: "Ver evento",
    },
  },
  {
    name: "event.cancelled (no money, no link)",
    variant: "event.cancelled",
    payload: { eventId: E, eventTitle: NM, startsAt: null, refund: null },
    en: {
      title: "Event cancelled",
      body: `${NM} has been cancelled.`,
      label: null,
    },
    es: { title: "Evento cancelado", body: `Se canceló ${NM}.`, label: null },
  },
  {
    name: "event.changed (rescheduled)",
    variant: "event.changed",
    payload: {
      eventId: E,
      eventTitle: NM,
      changeType: "RESCHEDULED",
      newStartsAt: START,
      newEndsAt: null,
      eventUrl: EVENT_URL,
    },
    en: {
      title: "Event rescheduled",
      body: `${NM} has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.`,
      label: "View event",
    },
    es: {
      title: "Evento reprogramado",
      body: `${NM} tiene una nueva fecha. Ahora empieza el viernes 13 de noviembre de 2026 a las 19:30 (GMT-6).`,
      label: "Ver evento",
    },
  },
  {
    name: "event.changed (rescheduled, no time)",
    variant: "event.changed",
    payload: {
      eventId: E,
      eventTitle: NM,
      changeType: "RESCHEDULED",
      newStartsAt: null,
      newEndsAt: null,
    },
    en: {
      title: "Event rescheduled",
      body: `${NM} has a new date.`,
      label: null,
    },
    es: {
      title: "Evento reprogramado",
      body: `${NM} tiene una nueva fecha.`,
      label: null,
    },
  },
  {
    name: "event.changed (venue changed)",
    variant: "event.changed",
    payload: {
      eventId: E,
      eventTitle: NM,
      changeType: "VENUE_CHANGED",
      newStartsAt: null,
      newEndsAt: null,
      eventUrl: EVENT_URL,
    },
    en: {
      title: "Event moved to a new location",
      body: `${NM} has moved to a new location.`,
      label: "View event",
    },
    es: {
      title: "Cambió la ubicación del evento",
      body: `${NM} cambió de ubicación.`,
      label: "Ver evento",
    },
  },
  {
    name: "event.unlisted",
    variant: "event.unlisted",
    payload: { eventId: E, eventTitle: NM },
    en: {
      title: "Event no longer available",
      body: `${NM} is no longer listed.`,
      label: null,
    },
    es: {
      title: "Evento ya no disponible",
      body: `${NM} ya no está a la vista del público.`,
      label: null,
    },
  },
  {
    name: "event.location-revealed (venue)",
    variant: "event.location-revealed",
    payload: {
      eventId: E,
      eventTitle: NM,
      address: "123 Main St, Minneapolis, MN",
      venueName: "The Hall",
      startsAtIso: START,
      timezone: "America/Chicago",
      eventUrl: EVENT_URL,
    },
    en: {
      title: `Location revealed: ${NM}`,
      body: `The location for ${NM} is now live: The Hall — 123 Main St, Minneapolis, MN.`,
      label: "View event",
    },
    es: {
      title: `Ubicación revelada: ${NM}`,
      body: `La ubicación de ${NM} ya está disponible: The Hall — 123 Main St, Minneapolis, MN.`,
      label: "Ver evento",
    },
  },
  {
    name: "event.location-revealed (no venue, no link)",
    variant: "event.location-revealed",
    payload: {
      eventId: E,
      eventTitle: NM,
      address: "123 Main St",
      startsAtIso: START,
    },
    en: {
      title: `Location revealed: ${NM}`,
      body: `The location for ${NM} is now live: 123 Main St.`,
      label: null,
    },
    es: {
      title: `Ubicación revelada: ${NM}`,
      body: `La ubicación de ${NM} ya está disponible: 123 Main St.`,
      label: null,
    },
  },
  {
    name: "event.venue-confirmed",
    variant: "event.venue-confirmed",
    payload: VENUE_BASE,
    en: {
      title: `The Hall confirmed ${NM}`,
      body: "The place vouched for your event. Its name and a link to its page now show on your event.",
      label: "View your event",
    },
    es: {
      title: `The Hall confirmó ${NM}`,
      body: "El lugar respaldó tu evento. Su nombre y un enlace a su página ya aparecen en tu evento.",
      label: "Ver tu evento",
    },
  },
  {
    name: "event.venue-confirmation-withdrawn",
    variant: "event.venue-confirmation-withdrawn",
    payload: { ...VENUE_BASE, reason: "We double-booked that night." },
    en: {
      title: `The Hall withdrew its confirmation of ${NM}`,
      body: "Reason: We double-booked that night.\n\nYour event keeps its address but no longer shows the place's name or link. You can still edit it.",
      label: "Edit your event",
    },
    es: {
      title: `The Hall retiró su confirmación de ${NM}`,
      body: "Motivo: We double-booked that night.\n\nTu evento conserva su dirección, pero ya no muestra el nombre ni el enlace del lugar. Todavía puedes editarlo.",
      label: "Editar tu evento",
    },
  },
  {
    name: "image.moderation.held (with subject)",
    variant: "image.moderation.held",
    payload: MOD_BASE,
    en: {
      title: "Your image is being reviewed",
      body: `The image you uploaded for "${NM}" is being reviewed and will appear once it's approved. No action is needed.`,
      label: "View event",
    },
    es: {
      title: "Tu imagen está en revisión",
      body: `La imagen que subiste para «${NM}» está en revisión y aparecerá cuando se apruebe. No tienes que hacer nada.`,
      label: "Ver evento",
    },
  },
  {
    name: "image.moderation.held (no subject)",
    variant: "image.moderation.held",
    payload: {
      ...MOD_BASE,
      subjectType: null,
      subjectId: null,
      subjectTitle: null,
      subjectUrl: null,
    },
    en: {
      title: "Your image is being reviewed",
      body: "The image you uploaded is being reviewed and will appear once it's approved. No action is needed.",
      label: null,
    },
    es: {
      title: "Tu imagen está en revisión",
      body: "La imagen que subiste está en revisión y aparecerá cuando se apruebe. No tienes que hacer nada.",
      label: null,
    },
  },
  {
    name: "image.moderation.approved",
    variant: "image.moderation.approved",
    payload: { ...MOD_BASE, note: null },
    en: {
      title: "Your image is now live",
      body: `The image you uploaded for "${NM}" has been approved and is now visible.`,
      label: "View event",
    },
    es: {
      title: "Tu imagen ya es visible",
      body: `La imagen que subiste para «${NM}» fue aprobada y ya es visible.`,
      label: "Ver evento",
    },
  },
  {
    name: "image.moderation.rejected",
    variant: "image.moderation.rejected",
    payload: { ...MOD_BASE, note: "Contains a watermark." },
    en: {
      title: "Your image wasn't approved",
      body: `The image you uploaded for "${NM}" wasn't approved and won't be shown. You can upload a different one anytime.`,
      label: "View event",
    },
    es: {
      title: "Tu imagen no fue aprobada",
      body: `La imagen que subiste para «${NM}» no fue aprobada y no se mostrará. Puedes subir otra cuando quieras.`,
      label: "Ver evento",
    },
  },
  {
    name: "place.availability-setup-needed",
    variant: "place.availability-setup-needed",
    payload: {
      placeId: P,
      placeName: "The Hall",
      calendarsUrl: "https://ithas.fire/admin/the-hall/calendars",
    },
    en: {
      title: "Set your hours so acts can reach you",
      body: "Until The Hall has hours, every date shows as unavailable and acts can't send you a booking request.",
      label: "Set your hours",
    },
    es: {
      title: "Define tus horarios para recibir solicitudes de contratación",
      body: "Mientras The Hall no tenga horarios, todas las fechas aparecerán como no disponibles y nadie podrá enviarte una solicitud de contratación.",
      label: "Definir horarios",
    },
  },
  {
    name: "post-event.performer-review-prompt",
    variant: "post-event.performer-review-prompt",
    payload: {
      eventId: E,
      eventTitle: NM,
      placeId: P,
      placeName: "The Hall",
      reviewUrl: "https://ithas.fire/review-a-place?placeId=x",
    },
    en: {
      title: "How was your gig at The Hall?",
      body: `You played ${NM} at The Hall. Rate the place to help other artists know what to expect.`,
      label: "Rate this place",
    },
    es: {
      title: "¿Qué tal tu presentación en The Hall?",
      body: `Participaste en ${NM}, en The Hall. Deja una reseña del lugar para que la comunidad artística sepa qué esperar.`,
      label: "Reseñar este lugar",
    },
  },
  {
    name: "post-event.attendee-review-prompt (venue)",
    variant: "post-event.attendee-review-prompt",
    payload: {
      eventId: E,
      eventTitle: NM,
      placeName: "The Hall",
      reviewUrl: `https://ithas.fire/review-event/${E}`,
    },
    en: {
      title: `How was ${NM}?`,
      body: `You were at ${NM} at The Hall. Tell the organizer how it went — just this once, we don't send reminders.`,
      label: "Rate this show",
    },
    es: {
      title: `¿Qué tal estuvo ${NM}?`,
      body: `Estuviste en ${NM}, en The Hall. Deja una reseña para contarle a quien organiza cómo te fue. Solo te lo pedimos esta vez: no enviamos recordatorios.`,
      label: "Reseñar este evento",
    },
  },
  {
    name: "post-event.attendee-review-prompt (no venue)",
    variant: "post-event.attendee-review-prompt",
    payload: {
      eventId: E,
      eventTitle: NM,
      reviewUrl: `https://ithas.fire/review-event/${E}`,
    },
    en: {
      title: `How was ${NM}?`,
      body: `You were at ${NM}. Tell the organizer how it went — just this once, we don't send reminders.`,
      label: "Rate this show",
    },
    es: {
      title: `¿Qué tal estuvo ${NM}?`,
      body: `Estuviste en ${NM}. Deja una reseña para contarle a quien organiza cómo te fue. Solo te lo pedimos esta vez: no enviamos recordatorios.`,
      label: "Reseñar este evento",
    },
  },
];

describe("event, moderation and venue notices, per locale", () => {
  for (const c of CASES) {
    it(`${c.name}: en`, () => {
      expect(inApp(c.variant, c.payload, "en")).toEqual(c.en);
    });
    it(`${c.name}: es`, () => {
      expect(inApp(c.variant, c.payload, "es")).toEqual(c.es);
    });
  }
});
