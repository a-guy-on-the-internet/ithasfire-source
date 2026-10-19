import { describe, expect, it } from "vitest";

import { LEGACY_OWNER_SIDE } from "../../../lib/legacy-place-values";
import { renderNotification } from "../renderers";

// Pins the in-app copy of the booking notices (requests, asks, messages and
// the hold family), per locale. English is pinned EXACTLY (it is what `notify`
// stores and what email, push and search see); Spanish is pinned so a copy
// edit is a visible diff. Every case also proves email and push stay English
// whatever the render locale.

const NOW = new Date("2026-08-01T12:00:00Z");
const REQ = "11111111-0000-4000-8000-000000000001";
const HOLD = "22222222-0000-4000-8000-000000000002";
const ASK = "33333333-0000-4000-8000-000000000003";
const MSG = "44444444-0000-4000-8000-000000000004";
const HUMAN = "55555555-0000-4000-8000-000000000005";
const PLACE = "66666666-0000-4000-8000-000000000006";
const URL = "https://ithas.fire/admin/the-hall/bookings/requests/x";

// ICU puts a narrow no-break space before "PM"; compare on plain spaces.
const plain = (s: string | null | undefined) =>
  (s ?? "").replace(/[  ]/gu, " ");

type Copy = { title: string; body: string; label: string };
type Case = {
  name: string;
  variant: string;
  payload: Record<string, unknown>;
  en: Copy;
  es: Copy;
};

const holdBase = {
  bookingRequestId: REQ,
  holdId: HOLD,
  placeName: "The Hall",
  date: "2026-08-14",
  timezone: "America/Chicago",
  targetUrl: URL,
};
// Wed, Aug 12 at 6:00 PM CDT.
const RESPOND_BY = "2026-08-12T23:00:00.000Z";

const EN_DATE = "Fri, Aug 14, 2026";
const ES_DATE = "viernes 14 de agosto de 2026";
const EN_RB = "Wed, Aug 12 at 6:00 PM CDT";
const ES_RB = "miércoles 12 de agosto de 2026 a las 18:00 (GMT-5)";

const CASES: Case[] = [
  // ── requests ───────────────────────────────────────────────────────────────
  {
    name: "request-received",
    variant: "booking.request-received",
    payload: {
      bookingRequestId: REQ,
      placeId: PLACE,
      placeName: "The Hall",
      actName: "Los Lobos Chicos",
      message: "We'd love a Friday.",
      source: "PLATFORM",
      inboxUrl: URL,
    },
    en: {
      title: "New booking request for The Hall",
      body: "Los Lobos Chicos wants to play The Hall.",
      label: "Open booking inbox",
    },
    es: {
      title: "Nueva solicitud de contratación para The Hall",
      body: "Los Lobos Chicos quiere tocar en The Hall.",
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "lineup-invited (person)",
    variant: "booking.lineup-invited",
    payload: {
      bookingRequestId: REQ,
      humanId: HUMAN,
      senderName: "Rosa",
      venueName: "The Hall",
      preferredDates: ["2026-08-14T20:00"],
      targetUrl: URL,
    },
    en: {
      title: "Rosa added you to a bill at The Hall",
      body: "They pitched The Hall with you on the bill. Join if you're in, or pass — either way takes one tap.",
      label: "Review",
    },
    es: {
      title: "Rosa te sumó a un lineup en The Hall",
      body: "Le propuso a The Hall un lineup contigo. Únete o pasa: cualquiera de las dos opciones es de un solo toque.",
      label: "Revisar",
    },
  },
  {
    name: "lineup-invited (group)",
    variant: "booking.lineup-invited",
    payload: {
      bookingRequestId: REQ,
      humanId: HUMAN,
      senderName: "Rosa",
      venueName: "The Hall",
      asGroupName: "Los Lobos Chicos",
      targetUrl: URL,
    },
    en: {
      title: "Rosa added Los Lobos Chicos to a bill at The Hall",
      body: "They pitched The Hall with Los Lobos Chicos on the bill. Join if you're in, or pass — either way takes one tap, and you can answer for the group.",
      label: "Review",
    },
    es: {
      title: "Rosa sumó a Los Lobos Chicos a un lineup en The Hall",
      body: "Le propuso a The Hall un lineup con Los Lobos Chicos. Únete o pasa: cualquiera de las dos opciones es de un solo toque, y puedes responder por el grupo.",
      label: "Revisar",
    },
  },
  {
    name: "organizer-request-received (event attached)",
    variant: "booking.organizer-request-received",
    payload: {
      bookingRequestId: REQ,
      orgName: "Acme Presents",
      message: "Come play.",
      attachedEventTitle: "Sunset Sessions",
      requestsUrl: URL,
    },
    en: {
      title: "Acme Presents wants to book you",
      body: "Acme Presents is asking you to play Sunset Sessions.",
      label: "View request",
    },
    es: {
      title: "Acme Presents quiere contratarte",
      body: "Acme Presents te pide tocar en Sunset Sessions.",
      label: "Ver solicitud",
    },
  },
  {
    name: "organizer-request-received (no event)",
    variant: "booking.organizer-request-received",
    payload: {
      bookingRequestId: REQ,
      orgName: "Acme Presents",
      message: "Come play.",
      requestsUrl: URL,
    },
    en: {
      title: "Acme Presents wants to book you",
      body: "Acme Presents sent you a booking request.",
      label: "View request",
    },
    es: {
      title: "Acme Presents quiere contratarte",
      body: "Acme Presents te envió una solicitud de contratación.",
      label: "Ver solicitud",
    },
  },
  {
    name: "organizer-request-responded (accepted)",
    variant: "booking.organizer-request-responded",
    payload: {
      bookingRequestId: REQ,
      actName: "Los Lobos Chicos",
      action: "accepted",
      agreementId: HOLD,
      targetUrl: URL,
    },
    en: {
      title: "Los Lobos Chicos accepted your booking request",
      body: "Los Lobos Chicos accepted — a draft agreement is ready to finish together.",
      label: "Open the agreement",
    },
    es: {
      title: "Los Lobos Chicos aceptó tu solicitud de contratación",
      body: "Los Lobos Chicos aceptó: hay un borrador de acuerdo listo para completar en conjunto.",
      label: "Abrir el acuerdo",
    },
  },
  {
    name: "organizer-request-responded (declined)",
    variant: "booking.organizer-request-responded",
    payload: {
      bookingRequestId: REQ,
      actName: "Los Lobos Chicos",
      action: "declined",
      targetUrl: URL,
    },
    en: {
      title: "Los Lobos Chicos declined your booking request",
      body: "Los Lobos Chicos declined your booking request.",
      label: "Open your bookings",
    },
    es: {
      title: "Los Lobos Chicos rechazó tu solicitud de contratación",
      body: "Los Lobos Chicos rechazó tu solicitud de contratación.",
      label: "Abrir tus contrataciones",
    },
  },
  {
    name: "request-responded (accepted, agreement ready)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: REQ,
      responderName: "Los Lobos Chicos",
      action: "accepted",
      acceptedNext: "agreement_ready",
      agreementId: HOLD,
      targetUrl: URL,
    },
    en: {
      title: "Los Lobos Chicos accepted your booking request",
      body: "A draft agreement is open for you both.",
      label: "Open the agreement",
    },
    es: {
      title: "Los Lobos Chicos aceptó tu solicitud de contratación",
      body: "Hay un borrador de acuerdo abierto para ambas partes.",
      label: "Abrir el acuerdo",
    },
  },
  {
    name: "request-responded (accepted, terms coming)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: REQ,
      responderName: "The Hall",
      action: "accepted",
      acceptedNext: "terms_coming",
      targetUrl: URL,
    },
    en: {
      title: "The Hall accepted your booking request",
      body: "They'll send terms for a night.",
      label: "View the request",
    },
    es: {
      title: "The Hall aceptó tu solicitud de contratación",
      body: "Te enviarán condiciones para una noche.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "request-responded (declined, with reason)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: REQ,
      responderName: "The Hall",
      action: "declined",
      reason: "We're booked solid.",
      targetUrl: URL,
    },
    en: {
      title: "The Hall declined your booking request",
      body: "This request won't go ahead. Their reason: We're booked solid.",
      label: "View the request",
    },
    es: {
      title: "The Hall rechazó tu solicitud de contratación",
      body: "Esta solicitud no seguirá adelante. Su motivo: We're booked solid.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "request-responded (declined, no reason)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: REQ,
      responderName: "The Hall",
      action: "declined",
      targetUrl: URL,
    },
    en: {
      title: "The Hall declined your booking request",
      body: "This request won't go ahead.",
      label: "View the request",
    },
    es: {
      title: "The Hall rechazó tu solicitud de contratación",
      body: "Esta solicitud no seguirá adelante.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "request-responded (closed, with reason)",
    variant: "booking.request-responded",
    payload: {
      bookingRequestId: REQ,
      responderName: "The Hall",
      action: "closed",
      reason: "Room flooded.",
      targetUrl: URL,
    },
    en: {
      title: "The Hall closed your booking request",
      body: "They closed the request after accepting it. It won't go ahead. Their reason: Room flooded.",
      label: "View the request",
    },
    es: {
      title: "The Hall cerró tu solicitud de contratación",
      body: "Cerraron la solicitud después de aceptarla. No seguirá adelante. Su motivo: Room flooded.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "booking-cancelled (event cancelled with it)",
    variant: "booking.booking-cancelled",
    payload: {
      bookingRequestId: REQ,
      cancelledByName: "The Hall",
      cancelledBy: "place",
      date: "2026-08-14",
      reason: "Room flooded.",
      eventCancelled: true,
      targetUrl: URL,
    },
    en: {
      title: `The Hall cancelled the booking for ${EN_DATE}`,
      body: "The night is free again, and the event is cancelled with it. Their reason: Room flooded.",
      label: "View the request",
    },
    es: {
      title: `The Hall canceló la contratación del ${ES_DATE}`,
      body: "La noche vuelve a estar libre y el evento se canceló con ella. Su motivo: Room flooded.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "booking-cancelled (no event)",
    variant: "booking.booking-cancelled",
    payload: {
      bookingRequestId: REQ,
      cancelledByName: "Los Lobos Chicos",
      cancelledBy: "sender",
      date: "2026-08-14",
      reason: "Van broke down.",
      eventCancelled: false,
      targetUrl: URL,
    },
    en: {
      title: `Los Lobos Chicos cancelled the booking for ${EN_DATE}`,
      body: "The night is free again. Their reason: Van broke down.",
      label: "View the request",
    },
    es: {
      title: `Los Lobos Chicos canceló la contratación del ${ES_DATE}`,
      body: "La noche vuelve a estar libre. Su motivo: Van broke down.",
      label: "Ver la solicitud",
    },
  },
  // ── asks ───────────────────────────────────────────────────────────────────
  {
    name: "ask-received (TEXT, with note)",
    variant: "booking.ask-received",
    payload: {
      bookingRequestId: REQ,
      askId: ASK,
      venueName: "The Hall",
      kind: "TEXT",
      label: "Stage plot",
      note: "Keep it short.",
      targetUrl: URL,
    },
    en: {
      title: "The Hall asked you for: Stage plot",
      body: "Keep it short.\n\nAnswer with a few words on the request.",
      label: "Answer the ask",
    },
    es: {
      title: "The Hall te pidió: Stage plot",
      body: "Keep it short.\n\nResponde con unas palabras en la solicitud.",
      label: "Responder a la pregunta",
    },
  },
  {
    name: "ask-received (FILE)",
    variant: "booking.ask-received",
    payload: {
      bookingRequestId: REQ,
      askId: ASK,
      venueName: "The Hall",
      kind: "FILE",
      label: "W-9",
      targetUrl: URL,
    },
    en: {
      title: "The Hall asked you for: W-9",
      body: "Answer with a file on the request.",
      label: "Answer the ask",
    },
    es: {
      title: "The Hall te pidió: W-9",
      body: "Responde con un archivo en la solicitud.",
      label: "Responder a la pregunta",
    },
  },
  {
    name: "ask-received (SET_LENGTH)",
    variant: "booking.ask-received",
    payload: {
      bookingRequestId: REQ,
      askId: ASK,
      venueName: "The Hall",
      kind: "SET_LENGTH",
      label: "Set length",
      targetUrl: URL,
    },
    en: {
      title: "The Hall asked you for: Set length",
      body: "Answer with a set length on the request.",
      label: "Answer the ask",
    },
    es: {
      title: "The Hall te pidió: Set length",
      body: "Responde con la duración del set en la solicitud.",
      label: "Responder a la pregunta",
    },
  },
  {
    name: "ask-answered",
    variant: "booking.ask-answered",
    payload: {
      bookingRequestId: REQ,
      askId: ASK,
      answeredByName: "Los Lobos Chicos",
      kind: "IMAGE",
      label: "Press photo",
      targetUrl: URL,
    },
    en: {
      title: "Los Lobos Chicos answered: Press photo",
      body: "Open the request to see the answer.",
      label: "View the request",
    },
    es: {
      title: "Los Lobos Chicos respondió: Press photo",
      body: "Abre la solicitud para ver la respuesta.",
      label: "Ver la solicitud",
    },
  },
  {
    name: "message-received",
    variant: "booking.message-received",
    payload: {
      bookingRequestId: REQ,
      messageId: MSG,
      senderLabel: "The Hall",
      preview: "Can you do 9pm?",
      threadUrl: URL,
    },
    en: {
      title: "New message from The Hall",
      body: "Can you do 9pm?",
      label: "Open the conversation",
    },
    es: {
      title: "Nuevo mensaje de The Hall",
      // The preview is the author's own words: never translated.
      body: "Can you do 9pm?",
      label: "Abrir la conversación",
    },
  },
  // ── holds ──────────────────────────────────────────────────────────────────
  {
    name: "hold-placed (first)",
    variant: "booking.hold-placed",
    payload: { ...holdBase, position: 1 },
    en: {
      title: `The Hall is holding ${EN_DATE} for you`,
      body: `You're first in line for ${EN_DATE}.`,
      label: "View your request",
    },
    es: {
      title: `The Hall creó una reserva para ti el ${ES_DATE}`,
      body: `Tu reserva es la primera en la fila para el ${ES_DATE}.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-placed (3rd)",
    variant: "booking.hold-placed",
    payload: { ...holdBase, position: 3 },
    en: {
      title: `The Hall is holding ${EN_DATE} for you`,
      body: `You're 3rd in line for ${EN_DATE}.`,
      label: "View your request",
    },
    es: {
      title: `The Hall creó una reserva para ti el ${ES_DATE}`,
      body: `Tu reserva es la 3.ª en la fila para el ${ES_DATE}.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-placed-batch",
    variant: "booking.hold-placed-batch",
    payload: {
      ...holdBase,
      dates: [
        { date: "2026-08-14", position: 1 },
        { date: "2026-08-15", position: 2 },
        { date: "2026-08-21", position: 11 },
      ],
    },
    en: {
      title: "The Hall is holding 3 dates for you",
      body: `${EN_DATE} — first in line; Sat, Aug 15, 2026 — 2nd in line; Fri, Aug 21, 2026 — 11th in line`,
      label: "View your request",
    },
    es: {
      title: "The Hall creó reservas para ti en 3 fechas",
      body: `${ES_DATE}: 1.ª en la fila; sábado 15 de agosto de 2026: 2.ª en la fila; viernes 21 de agosto de 2026: 11.ª en la fila`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-position-changed (now first)",
    variant: "booking.hold-position-changed",
    payload: { ...holdBase, position: 1 },
    en: {
      title: `You're now first in line for ${EN_DATE}`,
      body: "The Hall moved your hold to the front of the line.",
      label: "View your request",
    },
    es: {
      title: `Tu reserva del ${ES_DATE} es ahora la primera en la fila`,
      body: "The Hall movió tu reserva al principio de la fila.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-position-changed (2nd)",
    variant: "booking.hold-position-changed",
    payload: { ...holdBase, position: 2 },
    en: {
      title: `Your spot in line for ${EN_DATE} changed`,
      body: "You're now 2nd in line at The Hall.",
      label: "View your request",
    },
    es: {
      title: `Cambió la posición de tu reserva del ${ES_DATE}`,
      body: "Tu reserva en The Hall es ahora la 2.ª en la fila.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-challenged (staff)",
    variant: "booking.hold-challenged",
    payload: {
      ...holdBase,
      audience: "staff",
      position: 1,
      respondByISO: RESPOND_BY,
      actName: "Los Lobos Chicos",
    },
    en: {
      title: `Challenge open: Los Lobos Chicos on ${EN_DATE}`,
      body: `Los Lobos Chicos has until ${EN_RB} to keep or release the hold.`,
      label: "Open booking inbox",
    },
    es: {
      title: `Reclamación abierta: Los Lobos Chicos el ${ES_DATE}`,
      body: `Los Lobos Chicos tiene hasta el ${ES_RB} para mantener o liberar la reserva.`,
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-challenged (act, first, generic)",
    variant: "booking.hold-challenged",
    payload: { ...holdBase, position: 1, respondByISO: RESPOND_BY },
    en: {
      title: `The Hall needs an answer on ${EN_DATE}`,
      body: `Another act is ready to book ${EN_DATE}. Keep or release your hold by ${EN_RB}, or it lapses.`,
      label: "Keep or release",
    },
    es: {
      title: `The Hall necesita tu respuesta sobre el ${ES_DATE}`,
      body: `Hay otra solicitud lista para quedarse con el ${ES_DATE}. Mantén o libera tu reserva antes del ${ES_RB}, o vencerá.`,
      label: "Mantener o liberar",
    },
  },
  {
    name: "hold-challenged (act, first, book_now)",
    variant: "booking.hold-challenged",
    payload: {
      ...holdBase,
      position: 1,
      respondByISO: RESPOND_BY,
      keepWill: "book_now",
    },
    en: {
      title: `The Hall needs an answer on ${EN_DATE}`,
      body: `Another act is ready to book ${EN_DATE}. Agree your terms by ${EN_RB} to keep it. Keep agrees them and books the night.`,
      label: "Keep or release",
    },
    es: {
      title: `The Hall necesita tu respuesta sobre el ${ES_DATE}`,
      body: `Hay otra solicitud lista para quedarse con el ${ES_DATE}. Acepta tus condiciones antes del ${ES_RB} para conservar la fecha. Al mantener tu reserva, se aceptan y la noche queda contratada.`,
      label: "Mantener o liberar",
    },
  },
  {
    name: "hold-challenged (act, first, ask_for_terms)",
    variant: "booking.hold-challenged",
    payload: {
      ...holdBase,
      position: 1,
      respondByISO: RESPOND_BY,
      keepWill: "ask_for_terms",
    },
    en: {
      title: `The Hall needs an answer on ${EN_DATE}`,
      body: `Another act is ready to book ${EN_DATE}. Keep it by ${EN_RB} and the place sends you terms. Agree them within 48 hours of keeping, or the hold lapses.`,
      label: "Keep or release",
    },
    es: {
      title: `The Hall necesita tu respuesta sobre el ${ES_DATE}`,
      body: `Hay otra solicitud lista para quedarse con el ${ES_DATE}. Mantén tu reserva antes del ${ES_RB} y el lugar te enviará condiciones. Acéptalas en las 48 horas siguientes a mantenerla, o la reserva vencerá.`,
      label: "Mantener o liberar",
    },
  },
  {
    name: "hold-challenged (act, next in line)",
    variant: "booking.hold-challenged",
    payload: { ...holdBase, position: 2, respondByISO: RESPOND_BY },
    en: {
      title: `The first hold on ${EN_DATE} was challenged`,
      body: `You're next in line at The Hall. You'll hear by ${EN_RB}.`,
      label: "View your request",
    },
    es: {
      title: `La primera reserva del ${ES_DATE} fue reclamada`,
      body: `Tu reserva es la siguiente en la fila de The Hall. Tendrás noticias antes del ${ES_RB}.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-challenge-extended (staff)",
    variant: "booking.hold-challenge-extended",
    payload: {
      ...holdBase,
      audience: "staff",
      position: 1,
      respondByISO: RESPOND_BY,
      actName: "Los Lobos Chicos",
    },
    en: {
      title: `Deadline moved for Los Lobos Chicos on ${EN_DATE}`,
      body: `Los Lobos Chicos has until ${EN_RB} to keep or release the hold.`,
      label: "Open booking inbox",
    },
    es: {
      title: `Plazo ampliado para Los Lobos Chicos el ${ES_DATE}`,
      body: `Los Lobos Chicos tiene hasta el ${ES_RB} para mantener o liberar la reserva.`,
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-challenge-extended (act, first)",
    variant: "booking.hold-challenge-extended",
    payload: { ...holdBase, position: 1, respondByISO: RESPOND_BY },
    en: {
      title: `More time to answer The Hall about ${EN_DATE}`,
      body: `Your deadline moved. Keep or release your hold by ${EN_RB}.`,
      label: "Keep or release",
    },
    es: {
      title: `Más tiempo para responder a The Hall sobre el ${ES_DATE}`,
      body: `Tu plazo cambió. Mantén o libera tu reserva antes del ${ES_RB}.`,
      label: "Mantener o liberar",
    },
  },
  {
    name: "hold-challenge-extended (act, next in line)",
    variant: "booking.hold-challenge-extended",
    payload: { ...holdBase, position: 2, respondByISO: RESPOND_BY },
    en: {
      title: `Update on ${EN_DATE} at The Hall`,
      body: `You're next in line at The Hall. You'll hear by ${EN_RB}.`,
      label: "View your request",
    },
    es: {
      title: `Novedades sobre el ${ES_DATE} en The Hall`,
      body: `Tu reserva es la siguiente en la fila de The Hall. Tendrás noticias antes del ${ES_RB}.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-challenge-answered (keeper, awaiting terms)",
    variant: "booking.hold-challenge-answered",
    payload: {
      ...holdBase,
      audience: "act",
      answer: "kept",
      awaitingTerms: true,
      respondByISO: RESPOND_BY,
    },
    en: {
      title: `You kept your hold on ${EN_DATE}`,
      body: `The Hall will send you terms. Agree them by ${EN_RB}, or the hold lapses.`,
      label: "View your request",
    },
    es: {
      title: `Mantuviste tu reserva del ${ES_DATE}`,
      body: `The Hall te enviará condiciones. Acéptalas antes del ${ES_RB} o la reserva vencerá.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-challenge-answered (next in line: first hold stands)",
    variant: "booking.hold-challenge-answered",
    payload: { ...holdBase, audience: "act", answer: "kept" },
    en: {
      title: `The first hold on ${EN_DATE} stands`,
      body: "The act ahead of you kept their hold at The Hall. You're still next in line.",
      label: "View your request",
    },
    es: {
      title: `La primera reserva del ${ES_DATE} se mantiene`,
      body: "La reserva que va delante de la tuya en The Hall se mantuvo. Tu reserva sigue siendo la siguiente en la fila.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-challenge-answered (staff, kept)",
    variant: "booking.hold-challenge-answered",
    payload: {
      ...holdBase,
      audience: "staff",
      answer: "kept",
      actName: "Los Lobos Chicos",
    },
    en: {
      title: `Los Lobos Chicos kept their hold on ${EN_DATE}`,
      body: "They're still first in line. Confirm the hold to book them, or release it.",
      label: "Open booking inbox",
    },
    es: {
      title: `Los Lobos Chicos mantuvo su reserva del ${ES_DATE}`,
      body: "Su reserva sigue siendo la primera en la fila. Confirma la reserva para cerrar la contratación, o libérala.",
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-challenge-answered (staff, kept, awaiting terms)",
    variant: "booking.hold-challenge-answered",
    payload: {
      ...holdBase,
      audience: "staff",
      answer: "kept",
      actName: "Los Lobos Chicos",
      awaitingTerms: true,
      respondByISO: RESPOND_BY,
    },
    en: {
      title: `Los Lobos Chicos kept their hold on ${EN_DATE}`,
      body: `Send them terms to keep this night. They have until ${EN_RB} to agree, or the hold lapses.`,
      label: "Open booking inbox",
    },
    es: {
      title: `Los Lobos Chicos mantuvo su reserva del ${ES_DATE}`,
      body: `Envíale condiciones para mantener esta noche. Tiene hasta el ${ES_RB} para aceptarlas o la reserva vencerá.`,
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-challenge-answered (staff, released)",
    variant: "booking.hold-challenge-answered",
    payload: {
      ...holdBase,
      audience: "staff",
      answer: "released",
      actName: "Los Lobos Chicos",
    },
    en: {
      title: `Los Lobos Chicos released their hold on ${EN_DATE}`,
      body: `The line for ${EN_DATE} moved up.`,
      label: "Open booking inbox",
    },
    es: {
      title: `Los Lobos Chicos liberó su reserva del ${ES_DATE}`,
      body: `La fila del ${ES_DATE} avanzó.`,
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-released (staff, event scheduled)",
    variant: "booking.hold-released",
    payload: {
      ...holdBase,
      reason: "EVENT_SCHEDULED",
      audience: "staff",
      actName: "Los Lobos Chicos",
    },
    en: {
      title: `Hold for Los Lobos Chicos on ${EN_DATE} was released`,
      body: "An event was scheduled on that date, so the hold left the line.",
      label: "Open booking inbox",
    },
    es: {
      title: `Se liberó la reserva de Los Lobos Chicos del ${ES_DATE}`,
      body: "Se programó un evento en esa fecha, así que la reserva salió de la fila.",
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-released (act, manual)",
    variant: "booking.hold-released",
    payload: { ...holdBase, reason: "MANUAL" },
    en: {
      title: `Your hold on ${EN_DATE} at The Hall was released`,
      body: "The Hall released the hold. Your request is still open.",
      label: "View your request",
    },
    es: {
      title: `Se liberó tu reserva del ${ES_DATE} en The Hall`,
      body: "The Hall liberó la reserva. Tu solicitud sigue abierta.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-released (act, sibling confirmed)",
    variant: "booking.hold-released",
    payload: { ...holdBase, reason: "SIBLING_CONFIRMED" },
    en: {
      title: `Your hold on ${EN_DATE} at The Hall was released`,
      body: "Your booking was confirmed for a different date, so this hold is no longer needed.",
      label: "View your request",
    },
    es: {
      title: `Se liberó tu reserva del ${ES_DATE} en The Hall`,
      body: "Tu contratación se confirmó para otra fecha, así que esta reserva ya no hace falta.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-released (act, request closed)",
    variant: "booking.hold-released",
    payload: { ...holdBase, reason: "REQUEST_CLOSED" },
    en: {
      title: `Your hold on ${EN_DATE} at The Hall was released`,
      body: "The request was closed, so the hold went with it.",
      label: "View your request",
    },
    es: {
      title: `Se liberó tu reserva del ${ES_DATE} en The Hall`,
      body: "La solicitud se cerró y la reserva con ella.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-released (act, event scheduled)",
    variant: "booking.hold-released",
    payload: { ...holdBase, reason: "EVENT_SCHEDULED" },
    en: {
      title: `Your hold on ${EN_DATE} at The Hall was released`,
      body: "The Hall scheduled an event on that date, so the hold was released. Your request is still open.",
      label: "View your request",
    },
    es: {
      title: `Se liberó tu reserva del ${ES_DATE} en The Hall`,
      body: "The Hall programó un evento en esa fecha, así que la reserva se liberó. Tu solicitud sigue abierta.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-lost-date",
    variant: "booking.hold-lost-date",
    payload: holdBase,
    en: {
      title: `${EN_DATE} at The Hall went to another act`,
      body: `Your hold on ${EN_DATE} was released. Your request stays open — you can propose another date in the thread.`,
      label: "View your request",
    },
    es: {
      title: `La fecha del ${ES_DATE} en The Hall se asignó a otro artista`,
      body: `Se liberó tu reserva del ${ES_DATE}. Tu solicitud sigue abierta: puedes proponer otra fecha en la conversación.`,
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-expired (act)",
    variant: "booking.hold-expired",
    payload: { ...holdBase, audience: "act" },
    en: {
      title: `Your hold on ${EN_DATE} at The Hall lapsed`,
      body: "The deadline to keep or release passed without an answer, so the hold was released. Your request is still open.",
      label: "View your request",
    },
    es: {
      title: `Venció tu reserva del ${ES_DATE} en The Hall`,
      body: "El plazo para mantener o liberar pasó sin respuesta, así que la reserva se liberó. Tu solicitud sigue abierta.",
      label: "Ver tu solicitud",
    },
  },
  {
    name: "hold-expired (staff)",
    variant: "booking.hold-expired",
    payload: { ...holdBase, audience: "staff", actName: "Los Lobos Chicos" },
    en: {
      title: `Hold for Los Lobos Chicos on ${EN_DATE} lapsed`,
      body: "They didn't answer the challenge in time. The hold was released and the line moved up.",
      label: "Open booking inbox",
    },
    es: {
      title: `Venció la reserva de Los Lobos Chicos del ${ES_DATE}`,
      body: "No respondió a la reclamación a tiempo. La reserva se liberó y la fila avanzó.",
      label: "Abrir bandeja de contrataciones",
    },
  },
  {
    name: "hold-confirmed",
    variant: "booking.hold-confirmed",
    payload: holdBase,
    en: {
      title: `The Hall confirmed ${EN_DATE}`,
      body: "Your date is booked. A draft event was created — the place will finish the details with you.",
      label: "View your booking",
    },
    es: {
      title: `The Hall confirmó el ${ES_DATE}`,
      body: "Tu fecha está contratada. Se creó un evento en borrador; el lugar terminará de definir los detalles contigo.",
      label: "Ver tu contratación",
    },
  },
];

const render = (c: Case, locale?: "en" | "es") =>
  renderNotification(c.variant, c.payload, { now: NOW, locale });

describe("booking notice in-app copy", () => {
  it.each(CASES)("en: $name", (c) => {
    const inApp = render(c).inApp;
    expect(plain(inApp?.title)).toBe(c.en.title);
    expect(plain(inApp?.body)).toBe(c.en.body);
    expect(inApp?.action?.label).toBe(c.en.label);
    // Explicit "en" renders the same as the default.
    expect(render(c, "en").inApp).toEqual(inApp);
  });

  it.each(CASES)("es: $name", (c) => {
    const inApp = render(c, "es").inApp;
    expect(plain(inApp?.title)).toBe(c.es.title);
    expect(plain(inApp?.body)).toBe(c.es.body);
    expect(inApp?.action?.label).toBe(c.es.label);
  });

  it.each(CASES)("es: $name keeps the route and everything but the words", (c) => {
    const en = render(c, "en");
    const es = render(c, "es");
    expect(es.inApp?.action?.href).toBe(en.inApp?.action?.href);
    expect(es.inApp?.action?.route).toBe(en.inApp?.action?.route);
    expect(es.inApp?.kind).toBe(en.inApp?.kind);
    expect(es.inApp?.tags).toEqual(en.inApp?.tags);
    expect(es.inApp?.metadata).toEqual(en.inApp?.metadata);
    expect(es.fingerprint).toEqual(en.fingerprint);
  });

  it.each(CASES)("es: $name leaves email and push English", (c) => {
    const en = render(c, "en");
    const es = render(c, "es");
    expect(es.push).toEqual(en.push);
    expect(es.email).toEqual(en.email);
    expect(es.sms).toEqual(en.sms);
  });
});

describe("hold notices never tell an act who else is in line (FR-012)", () => {
  const actCases = CASES.filter(
    (c) =>
      c.variant.startsWith("booking.hold-") &&
      (c.payload as { audience?: string }).audience !== "staff",
  );

  it.each(actCases)("$name: no other act's name in any locale", (c) => {
    for (const locale of ["en", "es"] as const) {
      const out = render(c, locale);
      const text = [out.inApp?.title, out.inApp?.body, out.push?.title, out.push?.body]
        .join(" ");
      expect(text).not.toContain("Los Lobos Chicos");
    }
  });
});

describe("booking-cancelled rows stored before 2026-10-18", () => {
  // The inbox re-renders a stored row from its payload in the reader's
  // language, and rows written before the place rename carry the old
  // spelling of `cancelledBy`. They must render exactly as a new row does.
  const payload = (cancelledBy: string) => ({
    bookingRequestId: REQ,
    cancelledByName: "The Hall",
    cancelledBy,
    date: "2026-08-14",
    reason: "Room flooded.",
    eventCancelled: true,
    targetUrl: URL,
  });

  it.each(["en", "es"] as const)("%s: the old spelling renders the same as place", (locale) => {
    const old = renderNotification("booking.booking-cancelled", payload(LEGACY_OWNER_SIDE), { now: NOW, locale });
    const current = renderNotification("booking.booking-cancelled", payload("place"), { now: NOW, locale });
    expect(old.inApp).toEqual(current.inApp);
    expect(old.inApp?.metadata).toMatchObject({ cancelledBy: "place" });
  });
});
