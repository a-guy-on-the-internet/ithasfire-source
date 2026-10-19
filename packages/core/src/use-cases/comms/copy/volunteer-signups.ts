import type { NotificationLocale } from "../locale";

import { esVolunteerRole, esVolunteerRoleClause } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the volunteer signup notices that go through `notify`
// (volunteering/*), one entry per `NotificationLocale` (pattern: ./rsvp.ts).
// In-app only: each email keeps the English, built from `.en` in renderers.ts.
//
// The English is exactly what the renderers produced before they read a
// locale; do not reword it.
//
// Event, ask, role, group, shift and person names are free text: verbatim.
// Spanish avoids the gendered "voluntario/a" and "coordinador/a": it says
// "tu inscripción", "tu turno de voluntariado", "personas voluntarias" and
// "coordinas". "Cupo" (not "lugar", which also means venue), as in
// ./applications.ts.
//
// volunteer.broadcast is NOT here: its title and body are all organizer text.
// ─────────────────────────────────────────────────────────────────────────────

export type VolunteerSignupReceivedCopy = {
  readonly title: (v: { eventTitle: string; approved: boolean }) => string;
  readonly body: (v: {
    eventTitle: string;
    roleName: string;
    approved: boolean;
  }) => string;
};

export const VOLUNTEER_SIGNUP_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: VolunteerSignupReceivedCopy;
} = {
  en: {
    title: ({ eventTitle, approved }) =>
      approved
        ? `You're confirmed to volunteer at ${eventTitle}`
        : `Thanks for signing up to volunteer at ${eventTitle}`,
    body: ({ eventTitle, roleName, approved }) =>
      approved
        ? `You're confirmed to volunteer at ${eventTitle} as ${roleName}.`
        : `Your signup for ${roleName} at ${eventTitle} is pending review.`,
  },
  es: {
    title: ({ eventTitle, approved }) =>
      approved
        ? `Tu inscripción de voluntariado en ${eventTitle} está confirmada`
        : `Recibimos tu inscripción de voluntariado en ${eventTitle}`,
    body: ({ eventTitle, roleName, approved }) =>
      approved
        ? `Tu inscripción ${esVolunteerRoleClause(roleName, "de voluntariado")} en ${eventTitle} está confirmada.`
        : `Tu inscripción ${esVolunteerRoleClause(roleName, "de voluntariado")} en ${eventTitle} está pendiente de revisión.`,
  },
};

export type VolunteerSignupApprovedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: { eventTitle: string; roleName: string }) => string;
  /** Event-path signups link to the event page, ask-path to the ask page. */
  readonly viewEventLabel: string;
  readonly viewDetailsLabel: string;
};

export const VOLUNTEER_SIGNUP_APPROVED_COPY: {
  readonly [L in NotificationLocale]: VolunteerSignupApprovedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `You're approved to volunteer at ${eventTitle}`,
    body: ({ eventTitle, roleName }) =>
      `You're approved to volunteer at ${eventTitle} as ${roleName}.`,
    viewEventLabel: "View event",
    viewDetailsLabel: "View details",
  },
  es: {
    title: ({ eventTitle }) =>
      `Tu inscripción de voluntariado en ${eventTitle} fue aprobada`,
    body: ({ eventTitle, roleName }) =>
      `Tu inscripción ${esVolunteerRoleClause(roleName, "de voluntariado")} en ${eventTitle} fue aprobada.`,
    viewEventLabel: "Ver evento",
    viewDetailsLabel: "Ver detalles",
  },
};

export type VolunteerSignupRejectedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: { eventTitle: string; roleName: string }) => string;
};

export const VOLUNTEER_SIGNUP_REJECTED_COPY: {
  readonly [L in NotificationLocale]: VolunteerSignupRejectedCopy;
} = {
  en: {
    title: ({ eventTitle }) =>
      `Update on your volunteer application for ${eventTitle}`,
    body: ({ eventTitle, roleName }) =>
      `Thanks for your interest in volunteering for ${eventTitle} as ${roleName}. Unfortunately the organizer wasn't able to approve your signup this time.`,
  },
  es: {
    title: ({ eventTitle }) => `Novedades sobre tu inscripción en ${eventTitle}`,
    body: ({ eventTitle, roleName }) =>
      `Gracias por tu interés en el voluntariado de ${eventTitle}${roleName === "Volunteer" ? "" : ` como ${roleName}`}. Esta vez tu inscripción no fue aprobada.`,
  },
};

export type VolunteerSpotOpenedCopy = {
  readonly title: (v: { eventTitle: string }) => string;
  readonly body: (v: {
    eventTitle: string;
    target: string;
    pendingCount: number;
  }) => string;
  readonly reviewLabel: string;
};

export const VOLUNTEER_SPOT_OPENED_COPY: {
  readonly [L in NotificationLocale]: VolunteerSpotOpenedCopy;
} = {
  en: {
    title: ({ eventTitle }) => `A volunteer spot opened at ${eventTitle}`,
    body: ({ eventTitle, target, pendingCount }) =>
      `A volunteer spot opened on ${eventTitle} — ${target}. ${
        pendingCount === 1
          ? "1 pending application is waiting."
          : `${pendingCount} pending applications are waiting.`
      }`,
    reviewLabel: "Review signups",
  },
  es: {
    title: ({ eventTitle }) => `Se liberó un cupo de voluntariado en ${eventTitle}`,
    body: ({ eventTitle, target, pendingCount }) =>
      `Se liberó un cupo en ${eventTitle} — ${target}. ${
        pendingCount === 1
          ? "Hay 1 inscripción pendiente."
          : `Hay ${pendingCount} inscripciones pendientes.`
      }`,
    reviewLabel: "Revisar inscripciones",
  },
};

export type VolunteerGroupCoordinatorAssignedCopy = {
  readonly title: (v: {
    groupName: string;
    askTitle: string;
    assignerName: string | null;
  }) => string;
  readonly body: (v: { groupName: string }) => string;
  readonly openLabel: string;
};

export const VOLUNTEER_GROUP_COORDINATOR_ASSIGNED_COPY: {
  readonly [L in NotificationLocale]: VolunteerGroupCoordinatorAssignedCopy;
} = {
  en: {
    title: ({ groupName, askTitle, assignerName }) =>
      assignerName
        ? `${assignerName} made you coordinator of ${groupName} for ${askTitle}`
        : `You're now coordinating ${groupName} for ${askTitle}`,
    body: ({ groupName }) =>
      `As coordinator of ${groupName}, you can review, approve and check in the volunteers in your group.`,
    openLabel: "Open your group",
  },
  es: {
    title: ({ groupName, askTitle, assignerName }) =>
      assignerName
        ? `${assignerName} te asignó para coordinar ${groupName} en ${askTitle}`
        : `Ahora coordinas ${groupName} en ${askTitle}`,
    body: ({ groupName }) =>
      `Al coordinar ${groupName}, puedes revisar, aprobar y registrar la llegada de las personas voluntarias de tu grupo.`,
    openLabel: "Abrir tu grupo",
  },
};

export type VolunteerPoolSignupReceivedCopy = {
  readonly title: (v: { askTitle: string }) => string;
  readonly body: (v: {
    askTitle: string;
    roleName: string;
    approved: boolean;
  }) => string;
  readonly openLabel: string;
};

export const VOLUNTEER_POOL_SIGNUP_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: VolunteerPoolSignupReceivedCopy;
} = {
  en: {
    title: ({ askTitle }) => `New volunteer signup for ${askTitle}`,
    body: ({ askTitle, roleName, approved }) =>
      approved
        ? `A new ${roleName} volunteer joined the general pool for ${askTitle} and is ready to be assigned to a group.`
        : `A new ${roleName} signup for ${askTitle} is waiting for review in the general pool.`,
    openLabel: "Open roster",
  },
  es: {
    title: ({ askTitle }) => `Nueva inscripción de voluntariado en ${askTitle}`,
    body: ({ askTitle, roleName, approved }) =>
      approved
        ? `Hay una nueva inscripción para ${esVolunteerRole(roleName)} en la bolsa general de ${askTitle}, lista para asignarse a un grupo.`
        : `Una nueva inscripción para ${esVolunteerRole(roleName)} en ${askTitle} espera revisión en la bolsa general.`,
    openLabel: "Abrir la lista",
  },
};

export type VolunteerGroupSignupAssignedCopy = {
  readonly title: (v: { volunteerName: string; groupName: string }) => string;
  readonly body: (v: {
    volunteerName: string;
    roleName: string;
    groupName: string;
    askTitle: string;
  }) => string;
  readonly openLabel: string;
};

export const VOLUNTEER_GROUP_SIGNUP_ASSIGNED_COPY: {
  readonly [L in NotificationLocale]: VolunteerGroupSignupAssignedCopy;
} = {
  en: {
    title: ({ volunteerName, groupName }) =>
      `${volunteerName} joined ${groupName}`,
    body: ({ volunteerName, roleName, groupName, askTitle }) =>
      `${volunteerName} (${roleName}) was assigned to your group ${groupName} for ${askTitle}.`,
    openLabel: "Open your group",
  },
  es: {
    title: ({ volunteerName, groupName }) =>
      `${volunteerName} se unió a ${groupName}`,
    body: ({ volunteerName, roleName, groupName, askTitle }) =>
      `Se asignó a ${volunteerName} (${esVolunteerRole(roleName)}) a tu grupo ${groupName} en ${askTitle}.`,
    openLabel: "Abrir tu grupo",
  },
};

export type VolunteerOccurrenceCancelledCopy = {
  readonly title: (v: { roleName: string; askTitle: string }) => string;
  /** `when` is already phrased for the locale (see renderers.ts). */
  readonly body: (v: {
    roleName: string;
    askTitle: string;
    when: string;
  }) => string;
  readonly viewLabel: string;
};

export const VOLUNTEER_OCCURRENCE_CANCELLED_COPY: {
  readonly [L in NotificationLocale]: VolunteerOccurrenceCancelledCopy;
} = {
  en: {
    title: ({ roleName, askTitle }) =>
      `Your ${roleName} shift for ${askTitle} was cancelled`,
    body: ({ roleName, askTitle, when }) =>
      `The ${roleName} shift you claimed for ${askTitle} (${when}) has been cancelled. No action needed — you're no longer expected that day.`,
    viewLabel: "View the schedule",
  },
  es: {
    title: ({ roleName, askTitle }) =>
      `Tu turno de ${esVolunteerRole(roleName)} en ${askTitle} fue cancelado`,
    body: ({ roleName, askTitle, when }) =>
      `Se canceló tu turno de ${esVolunteerRole(roleName)} en ${askTitle} del ${when}. No tienes que hacer nada: ya no te esperan ese día.`,
    viewLabel: "Ver los horarios",
  },
};
