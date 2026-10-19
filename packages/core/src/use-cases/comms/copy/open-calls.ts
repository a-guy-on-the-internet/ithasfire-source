import type { OpenCallPayKind } from "@th/ports/repos/events";

import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// Copy for the open-call notices (spec 2026-10-05 open calls, FR-009, FR-015,
// FR-017, FR-018, FR-020, FR-022), one entry per `NotificationLocale`
// (pattern: ./rsvp.ts). Both the in-app text AND the email text live here:
// the email builders in ../open-call-renderers.ts read the same catalog, so
// the two never drift, and an email can be written in any locale (guest
// emails pick theirs in `resolveGuestNoticeLocale`).
//
// Vocabulary (CONTEXT.md, Q37/Q38): an act is PICKED onto the event's
// LINEUP; the other answer is "Not this time" (code: REJECTED). Never
// pass / decline / reject / bill / slot. Spanish: "convocatoria" (open call),
// "postulación" / "postularse" (application / apply), "lineup", informal
// "tú". People are never gendered ("quienes organizan", names, "alguien").
//
// Free text is verbatim: the call title, act names, the pay details, the
// organizer's note and a message body. Names are nullable in the payloads
// (never an English fallback word), so each locale says "someone" itself.
// ─────────────────────────────────────────────────────────────────────────────

/** Labels for the pay kind a call posted (FR-002). */
export type OpenCallPayKindLabels = { readonly [K in OpenCallPayKind]: string };

type Title = (v: { callTitle: string }) => string;

export type OpenCallCommonCopy = {
  readonly payKind: OpenCallPayKindLabels;
  /** "Pay as posted: …" line, both in-app and email. */
  readonly payLine: (pay: string) => string;
  readonly rowEvent: string;
  readonly rowWhen: string;
  readonly rowPay: string;
  readonly openApplication: string;
  readonly dropOut: string;
  readonly makePage: string;
  /** Footer of every applicant-facing email. */
  readonly applicantFooter: string;
  /** Footer of every organizer-facing email. */
  readonly organizerFooter: string;
};

export type OpenCallPickedCopy = {
  readonly title: (v: { callTitle: string; actName: string | null; firstPick: boolean }) => string;
  readonly heading: (v: { actName: string | null; firstPick: boolean }) => string;
  /** In-app body: the dates (already formatted, null = none) and the pay line. */
  readonly body: (v: { dates: string | null; payLine: string }) => string;
  readonly lead: (v: { actName: string | null }) => string;
  readonly noContract: string;
  /** A guest's email: the Drop out link drops out in one tap (status page). */
  readonly dropOutOneTap: string;
  /** Signed in: the Drop out link opens the page where they drop out. */
  readonly dropOutFromPage: string;
  /** Guests only (Q34). */
  readonly makePageInvite: string;
};

export type OpenCallNotThisTimeCopy = {
  readonly title: Title;
  readonly lead: (v: { actName: string | null }) => string;
  readonly noteLabel: string;
  readonly note: (note: string) => string;
  readonly after: string;
};

export type OpenCallPulledCopy = {
  readonly title: Title;
  readonly body: string;
  readonly after: string;
};

export type OpenCallMessageCopy = {
  /** To the applicant: the organizers wrote. */
  readonly titleToApplicant: Title;
  /** To the organizer side: the applicant wrote. Null name = "someone". */
  readonly titleToOrganizer: (v: { callTitle: string; authorName: string | null }) => string;
  readonly messageLabel: string;
  readonly replyHint: string;
  readonly openConversation: string;
};

export type OpenCallDroppedOutCopy = {
  readonly title: (v: { callTitle: string; actName: string | null }) => string;
  readonly body: (v: { dates: string | null }) => string;
  readonly openApplications: string;
};

export type OpenCallReceivedCopy = {
  readonly title: Title;
  readonly body: string;
  /** A guest's email: the link below is their status page. */
  readonly keepLink: string;
  /** Signed in: the application lives in their applications list. */
  readonly inHub: string;
};

export type OpenCallGuestDuplicateCopy = {
  readonly title: Title;
  readonly body: string;
  readonly openCall: string;
};

export type OpenCallNoticesCopy = {
  readonly common: OpenCallCommonCopy;
  readonly picked: OpenCallPickedCopy;
  readonly notThisTime: OpenCallNotThisTimeCopy;
  readonly pulled: OpenCallPulledCopy;
  readonly message: OpenCallMessageCopy;
  readonly droppedOut: OpenCallDroppedOutCopy;
  readonly received: OpenCallReceivedCopy;
  readonly guestDuplicate: OpenCallGuestDuplicateCopy;
};

export const OPEN_CALL_NOTICES_COPY: {
  readonly [L in NotificationLocale]: OpenCallNoticesCopy;
} = {
  en: {
    common: {
      payKind: {
        FIXED: "A set fee",
        DOOR_SPLIT: "A split of the door",
        TICKET_SHARE: "A share of ticket sales",
        TICKET_QUOTA: "Sell tickets to play",
        UNPAID: "Unpaid",
        DISCUSSED_AFTER: "Worked out with the organizers",
      },
      payLine: (pay) => `Pay as posted: ${pay}`,
      rowEvent: "Event",
      rowWhen: "When",
      rowPay: "Pay as posted",
      openApplication: "Open your application",
      dropOut: "Drop out",
      makePage: "Make a page",
      applicantFooter:
        "You're getting this because you applied to an open call on Ithas Fire.",
      organizerFooter:
        "You're getting this because you can edit this event on Ithas Fire.",
    },
    picked: {
      title: ({ callTitle, actName, firstPick }) =>
        firstPick
          ? actName
            ? `${actName} is on the lineup for ${callTitle}`
            : `You're on the lineup for ${callTitle}`
          : actName
            ? `${actName} is on more dates of ${callTitle}`
            : `You're on more dates of ${callTitle}`,
      heading: ({ actName, firstPick }) =>
        firstPick
          ? actName
            ? `${actName} is on the lineup`
            : "You're on the lineup"
          : actName
            ? `${actName} is on more dates`
            : "You're on more dates",
      body: ({ dates, payLine }) => (dates ? `${dates}. ${payLine}.` : `${payLine}.`),
      lead: ({ actName }) =>
        actName
          ? `The organizers picked ${actName} from its application to their open call.`
          : "The organizers picked you from your application to their open call.",
      noContract:
        "Being picked doesn't sign anything or move any money. The pay above is what the call posted; work out the details with the organizers.",
      dropOutOneTap:
        "Can't make it after all? Drop out with one tap, and the organizers will be told.",
      dropOutFromPage:
        "Can't make it after all? Use the Drop out link below, and the organizers will be told.",
      makePageInvite:
        "Want your name on the lineup to lead somewhere? Make a page with this email address, and this application moves to it.",
    },
    notThisTime: {
      title: ({ callTitle }) => `Not this time: ${callTitle}`,
      lead: ({ actName }) =>
        actName
          ? `Thanks for applying as ${actName}. The organizers didn't pick the act this time.`
          : "Thanks for applying. The organizers didn't pick you this time.",
      noteLabel: "Their note",
      note: (note) => `Their note: ${note}`,
      after:
        "You can apply to their next call, and you can still message them from your application.",
    },
    pulled: {
      title: ({ callTitle }) => `Call pulled: ${callTitle}`,
      body: "The organizers called off this event or its open call, so your application is closed. It wasn't a decision about you.",
      after: "Your application and its messages stay where they are.",
    },
    message: {
      titleToApplicant: ({ callTitle }) => `The organizers of ${callTitle} wrote to you`,
      titleToOrganizer: ({ callTitle, authorName }) =>
        authorName
          ? `${authorName} wrote about their application to ${callTitle}`
          : `New message about an application to ${callTitle}`,
      messageLabel: "Message",
      replyHint: "Reply from the application. More messages in the next few minutes won't send another email.",
      openConversation: "Open the conversation",
    },
    droppedOut: {
      title: ({ callTitle, actName }) =>
        actName ? `${actName} dropped out of ${callTitle}` : `An act dropped out of ${callTitle}`,
      body: ({ dates }) =>
        dates
          ? `They took themselves off the lineup (${dates}). Their application now shows as dropped out.`
          : "They dropped out. Their application now shows as dropped out.",
      openApplications: "Open the applications",
    },
    received: {
      title: ({ callTitle }) => `Application sent: ${callTitle}`,
      body: "The organizers will see it in their queue. You'll hear back either way.",
      keepLink:
        "Keep this email. The link below shows your status and the organizers' messages, lets you edit until they open your application, and lets you withdraw.",
      inHub:
        "You'll find it, with any messages from the organizers, in your applications.",
    },
    guestDuplicate: {
      title: ({ callTitle }) => `You've already applied: ${callTitle}`,
      body: "You already have an open application to this call. Use the link in the email we sent when you first applied.",
      openCall: "Open the call",
    },
  },
  es: {
    common: {
      payKind: {
        FIXED: "Una tarifa fija",
        DOOR_SPLIT: "Un porcentaje de la entrada",
        TICKET_SHARE: "Una parte de la venta de boletos",
        TICKET_QUOTA: "Vender boletos para tocar",
        UNPAID: "Sin pago",
        DISCUSSED_AFTER: "Se acuerda con quienes organizan",
      },
      payLine: (pay) => `Pago según la convocatoria: ${pay}`,
      rowEvent: "Evento",
      rowWhen: "Cuándo",
      rowPay: "Pago según la convocatoria",
      openApplication: "Abrir tu postulación",
      dropOut: "Retirarme",
      makePage: "Crear una página",
      applicantFooter:
        "Recibes este correo porque te postulaste a una convocatoria en Ithas Fire.",
      organizerFooter:
        "Recibes este correo porque puedes editar este evento en Ithas Fire.",
    },
    picked: {
      title: ({ callTitle, actName, firstPick }) =>
        firstPick
          ? actName
            ? `${actName} está en el lineup de ${callTitle}`
            : `Estás en el lineup de ${callTitle}`
          : actName
            ? `${actName} tiene más fechas en ${callTitle}`
            : `Tienes más fechas en ${callTitle}`,
      heading: ({ actName, firstPick }) =>
        firstPick
          ? actName
            ? `${actName} está en el lineup`
            : "Estás en el lineup"
          : actName
            ? `${actName} tiene más fechas`
            : "Tienes más fechas",
      body: ({ dates, payLine }) => (dates ? `${dates}. ${payLine}.` : `${payLine}.`),
      lead: ({ actName }) =>
        actName
          ? `Quienes organizan eligieron a ${actName} a partir de la postulación que envió a su convocatoria.`
          : "Quienes organizan te eligieron a partir de tu postulación a su convocatoria.",
      noContract:
        "Que te elijan no implica firmar nada ni mover dinero. El pago de arriba es el que publicó la convocatoria; los detalles los acuerdas con quienes organizan.",
      dropOutOneTap:
        "¿Al final no puedes? Retírate con un toque y se les avisará a quienes organizan.",
      dropOutFromPage:
        "¿Al final no puedes? Usa el enlace Retirarme de abajo y se les avisará a quienes organizan.",
      makePageInvite:
        "¿Quieres que tu nombre en el lineup lleve a algún lado? Crea una página con este correo y esta postulación pasará a ella.",
    },
    notThisTime: {
      title: ({ callTitle }) => `Esta vez no: ${callTitle}`,
      lead: ({ actName }) =>
        actName
          ? `Gracias por la postulación de ${actName}. Esta vez quienes organizan no eligieron a ${actName}.`
          : "Gracias por postularte. Esta vez quienes organizan no te eligieron.",
      noteLabel: "Su nota",
      note: (note) => `Su nota: ${note}`,
      after:
        "Puedes postularte a su próxima convocatoria y todavía puedes escribirles desde tu postulación.",
    },
    pulled: {
      title: ({ callTitle }) => `Convocatoria retirada: ${callTitle}`,
      body: "Quienes organizan cancelaron este evento o su convocatoria, así que tu postulación quedó cerrada. No fue una decisión sobre ti.",
      after: "Tu postulación y sus mensajes siguen ahí.",
    },
    message: {
      titleToApplicant: ({ callTitle }) => `Quienes organizan ${callTitle} te escribieron`,
      titleToOrganizer: ({ callTitle, authorName }) =>
        authorName
          ? `${authorName} escribió sobre su postulación a ${callTitle}`
          : `Nuevo mensaje sobre una postulación a ${callTitle}`,
      messageLabel: "Mensaje",
      replyHint:
        "Responde desde la postulación. Si llegan más mensajes en los próximos minutos, no te enviaremos otro correo.",
      openConversation: "Abrir la conversación",
    },
    droppedOut: {
      title: ({ callTitle, actName }) =>
        actName
          ? `${actName} salió del lineup de ${callTitle}`
          : `Alguien salió del lineup de ${callTitle}`,
      body: ({ dates }) =>
        dates
          ? `Se quitó del lineup (${dates}). Su postulación ahora figura como retirada.`
          : "Se retiró. Su postulación ahora figura como retirada.",
      openApplications: "Abrir las postulaciones",
    },
    received: {
      title: ({ callTitle }) => `Postulación enviada: ${callTitle}`,
      body: "Quienes organizan la verán en su lista. Te avisaremos sea cual sea la respuesta.",
      keepLink:
        "Guarda este correo. Con el enlace de abajo ves el estado y los mensajes de quienes organizan, puedes editar hasta que abran tu postulación y puedes retirarla.",
      inHub:
        "La encontrarás, con los mensajes de quienes organizan, en tus postulaciones.",
    },
    guestDuplicate: {
      title: ({ callTitle }) => `Ya te postulaste: ${callTitle}`,
      body: "Ya tienes una postulación abierta en esta convocatoria. Usa el enlace del correo que te enviamos la primera vez.",
      openCall: "Abrir la convocatoria",
    },
  },
};

/** "A set fee: $200 + drinks", or just the label when there are no details. */
export function openCallPayText(
  locale: NotificationLocale,
  payKind: OpenCallPayKind | null,
  payDetails: string | null,
): string {
  const common = OPEN_CALL_NOTICES_COPY[locale].common;
  const label = payKind ? common.payKind[payKind] : common.payKind.DISCUSSED_AFTER;
  const details = payDetails?.trim();
  return details ? `${label}: ${details}` : label;
}
