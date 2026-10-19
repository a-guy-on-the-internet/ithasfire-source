import type { NotificationLocale } from "../locale";
import { esName } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the booking-request notices (requests, answers, asks,
// thread messages), one entry per `NotificationLocale`. The hold family lives
// in `./booking-holds.ts`.
//
// Same pattern as `./rsvp.ts`: a full `{ [L in NotificationLocale]: … }`;
// names, venue names, reasons, ask labels/notes and message previews are the
// people's own words and pass through verbatim; English is byte-for-byte what
// the renderer said before the move (it is what gets stored, emailed and
// pushed). Dates arrive already formatted in the render locale.
//
// Spanish vocabulary (decided): booking = "contratación", booking request =
// "solicitud de contratación", act = "artista", venue = "lugar", ask =
// "pregunta", terms = "condiciones". Informal "tú"; the act/venue named as a
// subject takes a singular verb ("Los Lobos Chicos aceptó") and no adjective
// that would gender them.
// ─────────────────────────────────────────────────────────────────────────────

/** Action labels several booking notices share. */
export type BookingCommonCopy = {
  /** Staff side: the place's booking inbox. */
  readonly openBookingInbox: string;
  /** Either side: the request's own page. */
  readonly viewTheRequest: string;
  readonly openTheAgreement: string;
};

export const BOOKING_COMMON_COPY: {
  readonly [L in NotificationLocale]: BookingCommonCopy;
} = {
  en: {
    openBookingInbox: "Open booking inbox",
    viewTheRequest: "View the request",
    openTheAgreement: "Open the agreement",
  },
  es: {
    openBookingInbox: "Abrir bandeja de contrataciones",
    viewTheRequest: "Ver la solicitud",
    openTheAgreement: "Abrir el acuerdo",
  },
};

// ── booking.request-received (venue staff) ───────────────────────────────────

export type BookingRequestReceivedCopy = {
  readonly title: (v: { placeName: string }) => string;
  readonly body: (v: { actName: string; placeName: string }) => string;
  readonly openInboxLabel: string;
};

export const BOOKING_REQUEST_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: BookingRequestReceivedCopy;
} = {
  en: {
    title: ({ placeName }) => `New booking request for ${placeName}`,
    body: ({ actName, placeName }) => `${actName} wants to play ${placeName}.`,
    openInboxLabel: BOOKING_COMMON_COPY.en.openBookingInbox,
  },
  es: {
    title: ({ placeName }) =>
      `Nueva solicitud de contratación para ${placeName}`,
    body: ({ actName, placeName }) =>
      `${esName(actName, "start")} quiere tocar en ${placeName}.`,
    openInboxLabel: BOOKING_COMMON_COPY.es.openBookingInbox,
  },
};

// ── booking.lineup-invited (tagged act) ──────────────────────────────────────
// CONTEXT.md "Join / Pass": never "confirm". `asGroupName` is set when the
// recipient answers for a group.

export type BookingLineupInvitedCopy = {
  readonly title: (v: {
    senderName: string;
    venueName: string;
    asGroupName: string | undefined;
  }) => string;
  readonly body: (v: {
    venueName: string;
    asGroupName: string | undefined;
  }) => string;
  readonly reviewLabel: string;
};

export const BOOKING_LINEUP_INVITED_COPY: {
  readonly [L in NotificationLocale]: BookingLineupInvitedCopy;
} = {
  en: {
    title: ({ senderName, venueName, asGroupName }) =>
      `${senderName} added ${asGroupName ?? "you"} to a bill at ${venueName}`,
    body: ({ venueName, asGroupName }) =>
      asGroupName
        ? `They pitched ${venueName} with ${asGroupName} on the bill. Join if you're in, or pass — either way takes one tap, and you can answer for the group.`
        : `They pitched ${venueName} with you on the bill. Join if you're in, or pass — either way takes one tap.`,
    reviewLabel: "Review",
  },
  es: {
    title: ({ senderName, venueName, asGroupName }) =>
      asGroupName
        ? `${esName(senderName, "start")} sumó a ${asGroupName} a un lineup en ${esName(venueName, "mid")}`
        : `${esName(senderName, "start")} te sumó a un lineup en ${esName(venueName, "mid")}`,
    body: ({ venueName, asGroupName }) =>
      asGroupName
        ? `Le propuso ${esName(venueName, "a")} un lineup con ${asGroupName}. Únete o pasa: cualquiera de las dos opciones es de un solo toque, y puedes responder por el grupo.`
        : `Le propuso ${esName(venueName, "a")} un lineup contigo. Únete o pasa: cualquiera de las dos opciones es de un solo toque.`,
    reviewLabel: "Revisar",
  },
};

// ── booking.organizer-request-received (act) ─────────────────────────────────

export type OrganizerBookingRequestReceivedCopy = {
  readonly title: (v: { orgName: string }) => string;
  readonly body: (v: {
    orgName: string;
    attachedEventTitle: string | undefined;
  }) => string;
  readonly viewRequestLabel: string;
};

export const ORGANIZER_BOOKING_REQUEST_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: OrganizerBookingRequestReceivedCopy;
} = {
  en: {
    title: ({ orgName }) => `${orgName} wants to book you`,
    body: ({ orgName, attachedEventTitle }) =>
      attachedEventTitle
        ? `${orgName} is asking you to play ${attachedEventTitle}.`
        : `${orgName} sent you a booking request.`,
    viewRequestLabel: "View request",
  },
  es: {
    title: ({ orgName }) => `${esName(orgName, "start")} quiere contratarte`,
    body: ({ orgName, attachedEventTitle }) =>
      attachedEventTitle
        ? `${esName(orgName, "start")} te pide tocar en ${attachedEventTitle}.`
        : `${esName(orgName, "start")} te envió una solicitud de contratación.`,
    viewRequestLabel: "Ver solicitud",
  },
};

// ── booking.organizer-request-responded (legacy; rows queued before the fold) ─

export type OrganizerBookingRequestRespondedCopy = {
  readonly title: (v: { actName: string; accepted: boolean }) => string;
  readonly body: (v: { actName: string; accepted: boolean }) => string;
  readonly label: (v: { accepted: boolean }) => string;
};

export const ORGANIZER_BOOKING_REQUEST_RESPONDED_COPY: {
  readonly [L in NotificationLocale]: OrganizerBookingRequestRespondedCopy;
} = {
  en: {
    title: ({ actName, accepted }) =>
      accepted
        ? `${actName} accepted your booking request`
        : `${actName} declined your booking request`,
    body: ({ actName, accepted }) =>
      accepted
        ? `${actName} accepted — a draft agreement is ready to finish together.`
        : `${actName} declined your booking request.`,
    label: ({ accepted }) =>
      accepted ? BOOKING_COMMON_COPY.en.openTheAgreement : "Open your bookings",
  },
  es: {
    title: ({ actName, accepted }) =>
      accepted
        ? `${actName} aceptó tu solicitud de contratación`
        : `${actName} rechazó tu solicitud de contratación`,
    body: ({ actName, accepted }) =>
      accepted
        ? `${actName} aceptó: hay un borrador de acuerdo listo para completar en conjunto.`
        : `${actName} rechazó tu solicitud de contratación.`,
    label: ({ accepted }) =>
      accepted ? BOOKING_COMMON_COPY.es.openTheAgreement : "Abrir tus contrataciones",
  },
};

// ── booking.request-responded (sender) ───────────────────────────────────────

export type BookingResponseAction = "accepted" | "declined" | "closed";
export type BookingAcceptedNext = "terms_coming" | "agreement_ready";

export type BookingRequestRespondedCopy = {
  readonly title: (v: {
    responderName: string;
    action: BookingResponseAction;
  }) => string;
  /** The push body too (English); the in-app body adds the reason. */
  readonly lede: (v: {
    action: BookingResponseAction;
    acceptedNext: BookingAcceptedNext | undefined;
  }) => string;
  readonly withReason: (v: { lede: string; reason: string }) => string;
  readonly label: (v: {
    action: BookingResponseAction;
    acceptedNext: BookingAcceptedNext | undefined;
  }) => string;
};

export const BOOKING_REQUEST_RESPONDED_COPY: {
  readonly [L in NotificationLocale]: BookingRequestRespondedCopy;
} = {
  en: {
    title: ({ responderName, action }) =>
      action === "accepted"
        ? `${responderName} accepted your booking request`
        : action === "declined"
          ? `${responderName} declined your booking request`
          : `${responderName} closed your booking request`,
    lede: ({ action, acceptedNext }) =>
      action === "accepted"
        ? acceptedNext === "agreement_ready"
          ? "A draft agreement is open for you both."
          : "They'll send terms for a night."
        : action === "declined"
          ? "This request won't go ahead."
          : "They closed the request after accepting it. It won't go ahead.",
    withReason: ({ lede, reason }) => `${lede} Their reason: ${reason}`,
    label: ({ action, acceptedNext }) =>
      action === "accepted" && acceptedNext === "agreement_ready"
        ? BOOKING_COMMON_COPY.en.openTheAgreement
        : BOOKING_COMMON_COPY.en.viewTheRequest,
  },
  es: {
    title: ({ responderName, action }) =>
      action === "accepted"
        ? `${esName(responderName, "start")} aceptó tu solicitud de contratación`
        : action === "declined"
          ? `${esName(responderName, "start")} rechazó tu solicitud de contratación`
          : `${esName(responderName, "start")} cerró tu solicitud de contratación`,
    lede: ({ action, acceptedNext }) =>
      action === "accepted"
        ? acceptedNext === "agreement_ready"
          ? "Hay un borrador de acuerdo abierto para ambas partes."
          : "Te enviarán condiciones para una noche."
        : action === "declined"
          ? "Esta solicitud no seguirá adelante."
          : "Cerraron la solicitud después de aceptarla. No seguirá adelante.",
    withReason: ({ lede, reason }) => `${lede} Su motivo: ${reason}`,
    label: ({ action, acceptedNext }) =>
      action === "accepted" && acceptedNext === "agreement_ready"
        ? BOOKING_COMMON_COPY.es.openTheAgreement
        : BOOKING_COMMON_COPY.es.viewTheRequest,
  },
};

// ── booking.booking-cancelled (both sides) ───────────────────────────────────

export type BookingCancelledCopy = {
  /** `dateLabel` is already formatted in the render locale. */
  readonly title: (v: { cancelledByName: string; dateLabel: string }) => string;
  readonly lede: (v: { eventCancelled: boolean }) => string;
  readonly body: (v: { lede: string; reason: string }) => string;
  readonly viewRequestLabel: string;
};

export const BOOKING_CANCELLED_COPY: {
  readonly [L in NotificationLocale]: BookingCancelledCopy;
} = {
  en: {
    title: ({ cancelledByName, dateLabel }) =>
      `${cancelledByName} cancelled the booking for ${dateLabel}`,
    lede: ({ eventCancelled }) =>
      eventCancelled
        ? "The night is free again, and the event is cancelled with it."
        : "The night is free again.",
    body: ({ lede, reason }) => `${lede} Their reason: ${reason}`,
    viewRequestLabel: BOOKING_COMMON_COPY.en.viewTheRequest,
  },
  es: {
    title: ({ cancelledByName, dateLabel }) =>
      `${esName(cancelledByName, "start")} canceló la contratación del ${dateLabel}`,
    lede: ({ eventCancelled }) =>
      eventCancelled
        ? "La noche vuelve a estar libre y el evento se canceló con ella."
        : "La noche vuelve a estar libre.",
    body: ({ lede, reason }) => `${lede} Su motivo: ${reason}`,
    viewRequestLabel: BOOKING_COMMON_COPY.es.viewTheRequest,
  },
};

// ── booking.ask-received / booking.ask-answered ──────────────────────────────

export type BookingAskKind = "IMAGE" | "FILE" | "LINK" | "TEXT" | "SET_LENGTH";

export type BookingAskReceivedCopy = {
  readonly title: (v: { venueName: string; label: string }) => string;
  /** What the ask's input will be, in words — "Answer with a file". */
  readonly answerPhrase: { readonly [K in BookingAskKind]: string };
  readonly lede: (v: { answerPhrase: string }) => string;
  readonly answerLabel: string;
};

export const BOOKING_ASK_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: BookingAskReceivedCopy;
} = {
  en: {
    title: ({ venueName, label }) => `${venueName} asked you for: ${label}`,
    answerPhrase: {
      IMAGE: "an image",
      FILE: "a file",
      LINK: "a link",
      TEXT: "a few words",
      SET_LENGTH: "a set length",
    },
    lede: ({ answerPhrase }) => `Answer with ${answerPhrase} on the request.`,
    answerLabel: "Answer the ask",
  },
  es: {
    title: ({ venueName, label }) =>
      `${esName(venueName, "start")} te pidió: ${label}`,
    answerPhrase: {
      IMAGE: "una imagen",
      FILE: "un archivo",
      LINK: "un enlace",
      TEXT: "unas palabras",
      SET_LENGTH: "la duración del set",
    },
    lede: ({ answerPhrase }) => `Responde con ${answerPhrase} en la solicitud.`,
    answerLabel: "Responder a la pregunta",
  },
};

export type BookingAskAnsweredCopy = {
  readonly title: (v: { answeredByName: string; label: string }) => string;
  readonly body: string;
  readonly viewRequestLabel: string;
};

export const BOOKING_ASK_ANSWERED_COPY: {
  readonly [L in NotificationLocale]: BookingAskAnsweredCopy;
} = {
  en: {
    title: ({ answeredByName, label }) => `${answeredByName} answered: ${label}`,
    body: "Open the request to see the answer.",
    viewRequestLabel: BOOKING_COMMON_COPY.en.viewTheRequest,
  },
  es: {
    title: ({ answeredByName, label }) =>
      `${esName(answeredByName, "start")} respondió: ${label}`,
    body: "Abre la solicitud para ver la respuesta.",
    viewRequestLabel: BOOKING_COMMON_COPY.es.viewTheRequest,
  },
};

// ── booking.message-received (either side of a thread) ───────────────────────
// The body is the message preview itself: the author's words, never touched.

export type BookingMessageReceivedCopy = {
  readonly title: (v: { senderLabel: string }) => string;
  readonly openConversationLabel: string;
};

export const BOOKING_MESSAGE_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: BookingMessageReceivedCopy;
} = {
  en: {
    title: ({ senderLabel }) => `New message from ${senderLabel}`,
    openConversationLabel: "Open the conversation",
  },
  es: {
    title: ({ senderLabel }) =>
      `Nuevo mensaje ${esName(senderLabel, "de")}`,
    openConversationLabel: "Abrir la conversación",
  },
};
