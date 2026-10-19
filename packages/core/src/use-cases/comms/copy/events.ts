import type { NotificationLocale } from "../locale";
import { COMMON_COPY, esName } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the event notices: follows, applications (organizer side),
// feedback, cancellation and change, location reveal, venue confirmation,
// venue setup and the post-event review prompts. One entry per
// `NotificationLocale`; see `./rsvp.ts` for the pattern.
//
// Event titles, place names, applicant names, addresses and venue-written
// reasons are interpolated verbatim, never translated. Dates arrive already
// formatted in the render locale.
// ─────────────────────────────────────────────────────────────────────────────

export type EntityNewEventCopy = {
  readonly title: (v: { entityName: string }) => string;
  /** `startsAt` is already formatted in the render locale; null = omit it. */
  readonly body: (v: { eventTitle: string; startsAt: string | null }) => string;
  readonly viewEventLabel: string;
};

export const ENTITY_NEW_EVENT_COPY: {
  readonly [L in NotificationLocale]: EntityNewEventCopy;
} = {
  en: {
    title: ({ entityName }) => `New event from ${entityName}`,
    body: ({ eventTitle, startsAt }) =>
      `${eventTitle}${startsAt ? ` — ${startsAt}` : ""}.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ entityName }) => `Nuevo evento de ${entityName}`,
    body: ({ eventTitle, startsAt }) =>
      `${eventTitle}${startsAt ? ` — ${startsAt}` : ""}.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export type EventApplicationSubmissionReceivedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: { applicantName: string; eventTitle: string }) => string;
  readonly reviewLabel: string;
};

export const EVENT_APPLICATION_SUBMISSION_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: EventApplicationSubmissionReceivedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `New application for ${eventTitle}`,
    body: ({ applicantName, eventTitle }) =>
      `${applicantName} applied to ${eventTitle}.`,
    reviewLabel: "Review applications",
  },
  es: {
    title: ({ eventTitle }) => `Nueva solicitud para ${eventTitle}`,
    body: ({ applicantName, eventTitle }) =>
      `${esName(applicantName, "start")} envió una solicitud para ${eventTitle}.`,
    reviewLabel: "Revisar solicitudes",
  },
};

export type EventAttendeeFeedbackRequestCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: {
    eventTitle: string;
    organizerName: string | null;
  }) => string;
  readonly leaveFeedbackLabel: string;
};

export const EVENT_ATTENDEE_FEEDBACK_REQUEST_COPY: {
  readonly [L in NotificationLocale]: EventAttendeeFeedbackRequestCopy;
} = {
  en: {
    title: ({ eventTitle }) => `How was ${eventTitle}?`,
    body: ({ eventTitle, organizerName }) =>
      `Tell us about your experience at ${eventTitle}${
        organizerName ? ` hosted by ${organizerName}` : ""
      }.`,
    leaveFeedbackLabel: "Leave feedback",
  },
  es: {
    title: ({ eventTitle }) => `¿Qué tal estuvo ${eventTitle}?`,
    body: ({ eventTitle, organizerName }) =>
      `Cuéntanos cómo te fue en ${eventTitle}${
        organizerName ? `, a cargo de ${organizerName}` : ""
      }.`,
    leaveFeedbackLabel: "Dejar comentarios",
  },
};

export type EventCancelledCopy = {
  readonly title: (v: { refund: "refunded" | "pending" | null }) => string;
  /** `amount` is the formatted refund; set only when `refund` is "refunded". */
  readonly body: (v: {
    eventTitle: string;
    refund: "refunded" | "pending" | null;
    amount: string | null;
  }) => string;
  readonly viewEventLabel: string;
};

export const EVENT_CANCELLED_COPY: {
  readonly [L in NotificationLocale]: EventCancelledCopy;
} = {
  en: {
    title: ({ refund }) =>
      refund === "refunded"
        ? "Event cancelled — refund on the way"
        : refund === "pending"
          ? "Event cancelled — refund in progress"
          : "Event cancelled",
    body: ({ eventTitle, refund, amount }) =>
      refund === "refunded"
        ? `${eventTitle} has been cancelled. You've been refunded ${amount}.`
        : refund === "pending"
          ? `${eventTitle} has been cancelled. Your refund is being processed and we'll follow up.`
          : `${eventTitle} has been cancelled.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ refund }) =>
      refund === "refunded"
        ? "Evento cancelado — reembolso en camino"
        : refund === "pending"
          ? "Evento cancelado — reembolso en proceso"
          : "Evento cancelado",
    body: ({ eventTitle, refund, amount }) =>
      refund === "refunded"
        ? `Se canceló ${eventTitle}. Te reembolsamos ${amount}.`
        : refund === "pending"
          ? `Se canceló ${eventTitle}. Estamos procesando tu reembolso y te avisaremos.`
          : `Se canceló ${eventTitle}.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export type EventChangedCopy = {
  readonly title: (v: { changeType: "RESCHEDULED" | "VENUE_CHANGED" }) => string;
  /** `newStartsAt` is formatted in the render locale; null = omit the sentence. */
  readonly body: (v: {
    eventTitle: string;
    changeType: "RESCHEDULED" | "VENUE_CHANGED";
    newStartsAt: string | null;
  }) => string;
  readonly viewEventLabel: string;
};

export const EVENT_CHANGED_COPY: {
  readonly [L in NotificationLocale]: EventChangedCopy;
} = {
  en: {
    title: ({ changeType }) =>
      changeType === "RESCHEDULED" ? "Event rescheduled" : "Event moved to a new location",
    body: ({ eventTitle, changeType, newStartsAt }) =>
      changeType === "RESCHEDULED"
        ? `${eventTitle} has a new date.` +
          (newStartsAt ? ` It now starts ${newStartsAt}.` : "")
        : `${eventTitle} has moved to a new location.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ changeType }) =>
      changeType === "RESCHEDULED"
        ? "Evento reprogramado"
        : "Cambió la ubicación del evento",
    body: ({ eventTitle, changeType, newStartsAt }) =>
      changeType === "RESCHEDULED"
        ? `${eventTitle} tiene una nueva fecha.` +
          (newStartsAt ? ` Ahora empieza el ${newStartsAt}.` : "")
        : `${eventTitle} cambió de ubicación.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export type EventUnlistedCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: string }) => string;
};

export const EVENT_UNLISTED_COPY: {
  readonly [L in NotificationLocale]: EventUnlistedCopy;
} = {
  en: {
    title: "Event no longer available",
    body: ({ eventTitle }) => `${eventTitle} is no longer listed.`,
  },
  es: {
    title: "Evento ya no disponible",
    body: ({ eventTitle }) => `${eventTitle} ya no está a la vista del público.`,
  },
};

export type EventLocationRevealedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: {
    eventTitle: string;
    venueName: string | null;
    address: string;
  }) => string;
  readonly viewEventLabel: string;
};

export const EVENT_LOCATION_REVEALED_COPY: {
  readonly [L in NotificationLocale]: EventLocationRevealedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `Location revealed: ${eventTitle}`,
    body: ({ eventTitle, venueName, address }) =>
      `The location for ${eventTitle} is now live: ${
        venueName ? `${venueName} — ` : ""
      }${address}.`,
    viewEventLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    title: ({ eventTitle }) => `Ubicación revelada: ${eventTitle}`,
    body: ({ eventTitle, venueName, address }) =>
      `La ubicación de ${eventTitle} ya está disponible: ${
        venueName ? `${venueName} — ` : ""
      }${address}.`,
    viewEventLabel: COMMON_COPY.es.viewEvent,
  },
};

export type EventVenueConfirmedCopy = {
  readonly title: (v: { placeName: string; eventTitle: string }) => string;
  readonly body: string;
  readonly viewEventLabel: string;
};

export const EVENT_VENUE_CONFIRMED_COPY: {
  readonly [L in NotificationLocale]: EventVenueConfirmedCopy;
} = {
  en: {
    title: ({ placeName, eventTitle }) => `${placeName} confirmed ${eventTitle}`,
    body: "The place vouched for your event. Its name and a link to its page now show on your event.",
    viewEventLabel: "View your event",
  },
  es: {
    title: ({ placeName, eventTitle }) =>
      `${esName(placeName, "start")} confirmó ${esName(eventTitle, "mid")}`,
    body: "El lugar respaldó tu evento. Su nombre y un enlace a su página ya aparecen en tu evento.",
    viewEventLabel: "Ver tu evento",
  },
};

export type EventVenueConfirmationWithdrawnCopy = {
  readonly title: (v: { placeName: string; eventTitle: string }) => string;
  /** `reason` is the venue's own words, verbatim. */
  readonly body: (v: { reason: string }) => string;
  readonly editEventLabel: string;
};

export const EVENT_VENUE_CONFIRMATION_WITHDRAWN_COPY: {
  readonly [L in NotificationLocale]: EventVenueConfirmationWithdrawnCopy;
} = {
  en: {
    title: ({ placeName, eventTitle }) =>
      `${placeName} withdrew its confirmation of ${eventTitle}`,
    body: ({ reason }) =>
      `Reason: ${reason}\n\nYour event keeps its address but no longer shows the place's name or link. You can still edit it.`,
    editEventLabel: "Edit your event",
  },
  es: {
    title: ({ placeName, eventTitle }) =>
      `${esName(placeName, "start")} retiró su confirmación ${esName(eventTitle, "de")}`,
    body: ({ reason }) =>
      `Motivo: ${reason}\n\nTu evento conserva su dirección, pero ya no muestra el nombre ni el enlace del lugar. Todavía puedes editarlo.`,
    editEventLabel: "Editar tu evento",
  },
};

export type PlaceAvailabilitySetupNeededCopy = {
  readonly title: string;
  readonly body: (v: { placeName: string }) => string;
  readonly setHoursLabel: string;
};

export const PLACE_AVAILABILITY_SETUP_NEEDED_COPY: {
  readonly [L in NotificationLocale]: PlaceAvailabilitySetupNeededCopy;
} = {
  en: {
    title: "Set your hours so acts can reach you",
    body: ({ placeName }) =>
      `Until ${placeName} has hours, every date shows as unavailable and acts can't send you a booking request.`,
    setHoursLabel: "Set your hours",
  },
  es: {
    title: "Define tus horarios para recibir solicitudes de contratación",
    body: ({ placeName }) =>
      `Mientras ${placeName} no tenga horarios, todas las fechas aparecerán como no disponibles y nadie podrá enviarte una solicitud de contratación.`,
    setHoursLabel: "Definir horarios",
  },
};

export type PostEventPerformerReviewPromptCopy = {
  readonly title: (v: { placeName: string }) => string;
  readonly body: (v: { eventTitle: string; placeName: string }) => string;
  readonly rateLabel: string;
};

export const POST_EVENT_PERFORMER_REVIEW_PROMPT_COPY: {
  readonly [L in NotificationLocale]: PostEventPerformerReviewPromptCopy;
} = {
  en: {
    title: ({ placeName }) => `How was your gig at ${placeName}?`,
    body: ({ eventTitle, placeName }) =>
      `You played ${eventTitle} at ${placeName}. ` +
      `Rate the place to help other artists know what to expect.`,
    rateLabel: "Rate this place",
  },
  es: {
    title: ({ placeName }) => `¿Qué tal tu presentación en ${placeName}?`,
    body: ({ eventTitle, placeName }) =>
      `Participaste en ${eventTitle}, en ${placeName}. ` +
      `Deja una reseña del lugar para que la comunidad artística sepa qué esperar.`,
    rateLabel: "Reseñar este lugar",
  },
};

export type PostEventAttendeeReviewPromptCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: {
    eventTitle: string;
    placeName: string | null;
  }) => string;
  readonly rateLabel: string;
};

export const POST_EVENT_ATTENDEE_REVIEW_PROMPT_COPY: {
  readonly [L in NotificationLocale]: PostEventAttendeeReviewPromptCopy;
} = {
  en: {
    title: ({ eventTitle }) => `How was ${eventTitle}?`,
    body: ({ eventTitle, placeName }) =>
      `You were at ${eventTitle}${placeName ? ` at ${placeName}` : ""}. ` +
      `Tell the organizer how it went — just this once, we don't send reminders.`,
    rateLabel: "Rate this show",
  },
  es: {
    title: ({ eventTitle }) => `¿Qué tal estuvo ${eventTitle}?`,
    body: ({ eventTitle, placeName }) =>
      `Estuviste en ${eventTitle}${placeName ? `, en ${placeName}` : ""}. ` +
      `Deja una reseña para contarle a quien organiza cómo te fue. ` +
      `Solo te lo pedimos esta vez: no enviamos recordatorios.`,
    rateLabel: "Reseñar este evento",
  },
};
