import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the applicant notices on APPLICATION-gated events, one entry
// per `NotificationLocale` (pattern: ./rsvp.ts).
//
// English is ALSO what the applicant emails say (the `application*Email`
// builders in ../application-renderers.ts read `.en` from here), so the two
// never drift; the email stays English whatever the in-app locale.
//
// The event title and the reviewer's note are organizer free text: verbatim.
// "Organizer" is gender-neutral in Spanish ("quien organiza").
// ─────────────────────────────────────────────────────────────────────────────

type TitleOnly = (v: { eventTitle: string }) => string;

export type ApplicationReceivedCopy = {
  readonly title: TitleOnly;
  readonly body: string;
};

export const APPLICATION_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: ApplicationReceivedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `Application sent: ${eventTitle}`,
    body: "Your spot isn't confirmed yet. We'll email you when the organizer decides.",
  },
  es: {
    title: ({ eventTitle }) => `Solicitud enviada: ${eventTitle}`,
    body: "Tu cupo aún no está confirmado. Te enviaremos un correo cuando quien organiza decida.",
  },
};

export type ApplicationApprovedCopy = {
  readonly title: TitleOnly;
  readonly body: string;
};

export const APPLICATION_APPROVED_COPY: {
  readonly [L in NotificationLocale]: ApplicationApprovedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're in: ${eventTitle}`,
    body: "The organizer approved your application. The event page is open to you now.",
  },
  es: {
    title: ({ eventTitle }) => `Estás dentro: ${eventTitle}`,
    body: "Quien organiza aprobó tu solicitud. La página del evento ya está abierta para ti.",
  },
};

export type ApplicationRejectedCopy = {
  readonly title: TitleOnly;
  /** The opening sentence; the whole body when there is no reviewer's note. */
  readonly lead: string;
  /** The reviewer's own words follow the prefix verbatim. */
  readonly note: (reason: string) => string;
};

export const APPLICATION_REJECTED_COPY: {
  readonly [L in NotificationLocale]: ApplicationRejectedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `Not approved: ${eventTitle}`,
    lead: "The organizer didn't approve your application.",
    note: (reason) => `Note from the organizer: ${reason}`,
  },
  es: {
    title: ({ eventTitle }) => `Solicitud no aprobada: ${eventTitle}`,
    lead: "Quien organiza no aprobó tu solicitud.",
    note: (reason) => `Nota de quien organiza: ${reason}`,
  },
};

/** Lead plus the note when there is one: the in-app body. */
export function applicationRejectedBody(
  copy: ApplicationRejectedCopy,
  decisionReason: string | null | undefined,
): string {
  return decisionReason
    ? `${copy.lead} ${copy.note(decisionReason)}`
    : copy.lead;
}

export type ApplicationWaitlistedCopy = {
  readonly title: TitleOnly;
  readonly body: string;
};

export const APPLICATION_WAITLISTED_COPY: {
  readonly [L in NotificationLocale]: ApplicationWaitlistedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `Waitlisted: ${eventTitle}`,
    body: "If a spot opens, we'll email you a link.",
  },
  es: {
    title: ({ eventTitle }) => `En lista de espera: ${eventTitle}`,
    body: "Si se libera un cupo, te enviaremos un enlace por correo.",
  },
};

export type ApplicationBackInReviewCopy = {
  readonly title: TitleOnly;
  readonly body: string;
};

// Deliberately silent on access: a guest's unlock cookie can't be revoked
// server-side, so "you lost access" could be false.
export const APPLICATION_BACK_IN_REVIEW_COPY: {
  readonly [L in NotificationLocale]: ApplicationBackInReviewCopy;
} = {
  en: {
    title: ({ eventTitle }) => `Back in review: ${eventTitle}`,
    body: "The organizer withdrew their approval. Your application is back in review.",
  },
  es: {
    title: ({ eventTitle }) => `De nuevo en revisión: ${eventTitle}`,
    body: "Quien organiza retiró su aprobación. Tu solicitud vuelve a estar en revisión.",
  },
};
