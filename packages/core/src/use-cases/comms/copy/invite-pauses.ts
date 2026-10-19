import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the invite complaint auto-pause (W4) notices
// (events/invites/invite-pause-notifications.ts). In-app only, by owner
// ruling 2026-10-07 ("just in app notification"): no email, no push.
//
// One entry per `NotificationLocale` (pattern: ./places-claims.ts). The org's
// name and the staff note are free text: verbatim. A person-owned organiser is
// the reader, so their notices say "your invites". Spanish never genders the
// reader or the team ("tus invitaciones", "nuestro equipo").
// ─────────────────────────────────────────────────────────────────────────────

type Reason = "COMPLAINT_COUNT" | "COMPLAINT_RATE";

/** Null `organiserName` = "your invites" (a person, or an org with no name). */
type Who = { organiserName: string | null };

// ── invite-pause.opened ──────────────────────────────────────────────────────

export type InvitePauseOpenedCopy = {
  readonly title: (v: Who) => string;
  /** The reason sentence. */
  readonly reason: (v: {
    reason: Reason;
    complaintCount: number;
    recipientCount: number;
    windowDays: number;
  }) => string;
  readonly next: string;
  /** When the action deep-links the event's Invited guests panel. */
  readonly actionLabel: string;
  /** When the action can only open the events list. */
  readonly eventsListLabel: string;
};

/**
 * The rate phrasing ("n of the m people you invited") only reads well when
 * the invites outnumber the complaints; otherwise (1 of 1, a complaint about
 * mail sent before the window, zero recent invites) say the count.
 */
function useRatePhrasing(v: {
  reason: Reason;
  complaintCount: number;
  recipientCount: number;
}): boolean {
  return v.reason === "COMPLAINT_RATE" && v.recipientCount > v.complaintCount;
}

export const INVITE_PAUSE_OPENED_COPY: {
  readonly [L in NotificationLocale]: InvitePauseOpenedCopy;
} = {
  en: {
    title: ({ organiserName }) =>
      organiserName
        ? `Invites from ${organiserName} are paused`
        : "Your invites are paused",
    reason: (v) => {
      const n = v.complaintCount;
      if (useRatePhrasing(v)) {
        return `${n} of the ${v.recipientCount} people you invited in the last ${v.windowDays} days marked the email as spam.`;
      }
      return n === 1
        ? `1 person marked your invite email as spam in the last ${v.windowDays} days.`
        : `${n} people marked your invite emails as spam in the last ${v.windowDays} days.`;
    },
    next: "Invite emails are on hold until a review lifts the pause. Your shared invite link still works.",
    actionLabel: "Ask for a review",
    eventsListLabel: "Open your events",
  },
  es: {
    title: ({ organiserName }) =>
      organiserName
        ? `Las invitaciones de ${organiserName} están en pausa`
        : "Tus invitaciones están en pausa",
    reason: (v) => {
      const n = v.complaintCount;
      if (useRatePhrasing(v)) {
        return n === 1
          ? `1 de las ${v.recipientCount} personas que invitaste en los últimos ${v.windowDays} días marcó el correo como spam.`
          : `${n} de las ${v.recipientCount} personas que invitaste en los últimos ${v.windowDays} días marcaron el correo como spam.`;
      }
      return n === 1
        ? `1 persona marcó tu correo de invitación como spam en los últimos ${v.windowDays} días.`
        : `${n} personas marcaron tus correos de invitación como spam en los últimos ${v.windowDays} días.`;
    },
    next: "Los correos de invitación quedan en espera hasta que una revisión levante la pausa. Tu enlace de invitación compartido sigue funcionando.",
    actionLabel: "Pedir una revisión",
    eventsListLabel: "Abrir tus eventos",
  },
};

export function invitePauseOpenedBody(
  copy: InvitePauseOpenedCopy,
  v: Parameters<InvitePauseOpenedCopy["reason"]>[0],
): string {
  return `${copy.reason(v)} ${copy.next}`;
}

// ── invite-pause.decided ─────────────────────────────────────────────────────

type Decision = "LIFTED" | "KEPT";

export type InvitePauseDecidedCopy = {
  readonly title: (v: Who & { decision: Decision }) => string;
  readonly lead: (v: { decision: Decision }) => string;
  readonly note: (note: string) => string;
  /** After a KEEP only: the way forward. */
  readonly askAgain: string;
  /** When the action deep-links the event's Invited guests panel. */
  readonly actionLabel: (v: { decision: Decision }) => string;
  /** When the action can only open the events list. */
  readonly eventsListLabel: string;
};

export const INVITE_PAUSE_DECIDED_COPY: {
  readonly [L in NotificationLocale]: InvitePauseDecidedCopy;
} = {
  en: {
    title: ({ organiserName, decision }) => {
      if (decision === "LIFTED") {
        return organiserName
          ? `Invites from ${organiserName} are back on`
          : "Your invites are back on";
      }
      return organiserName
        ? `Invites from ${organiserName} stay paused`
        : "Your invites stay paused";
    },
    lead: ({ decision }) =>
      decision === "LIFTED"
        ? "Our team reviewed the pause and lifted it. You can send invite emails again."
        : "Our team reviewed the pause and kept it for now.",
    note: (note) => `Note from our team: ${note}`,
    askAgain: "You can ask for another review.",
    actionLabel: ({ decision }) =>
      decision === "LIFTED" ? "Send invites" : "See what to do",
    eventsListLabel: "Open your events",
  },
  es: {
    title: ({ organiserName, decision }) => {
      if (decision === "LIFTED") {
        return organiserName
          ? `Las invitaciones de ${organiserName} vuelven a estar activas`
          : "Tus invitaciones vuelven a estar activas";
      }
      return organiserName
        ? `Las invitaciones de ${organiserName} siguen en pausa`
        : "Tus invitaciones siguen en pausa";
    },
    lead: ({ decision }) =>
      decision === "LIFTED"
        ? "Nuestro equipo revisó la pausa y la levantó. Ya puedes volver a enviar correos de invitación."
        : "Nuestro equipo revisó la pausa y la mantiene por ahora.",
    note: (note) => `Nota de nuestro equipo: ${note}`,
    askAgain: "Puedes pedir otra revisión.",
    actionLabel: ({ decision }) =>
      decision === "LIFTED" ? "Enviar invitaciones" : "Ver qué hacer",
    eventsListLabel: "Abrir tus eventos",
  },
};

/**
 * Staff write the note; end it as a sentence so it doesn't run into the
 * next one. A closing quote or bracket after the stop still counts.
 */
function endSentence(note: string): string {
  return /[.!?…]["'”’»)\]]*$/u.test(note) ? note : `${note}.`;
}

export function invitePauseDecidedBody(
  copy: InvitePauseDecidedCopy,
  v: { decision: Decision; note: string | null },
): string {
  const parts = [copy.lead(v)];
  if (v.note) parts.push(copy.note(endSentence(v.note)));
  if (v.decision === "KEPT") parts.push(copy.askAgain);
  return parts.join(" ");
}
