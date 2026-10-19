import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the listing-report notices
// (entity-reports/_shared/entity-report-notifications.ts writes the rows
// directly; rendered by `direct-money-safety-renderers.ts`).
//
// The English strings are the producer's original text, except that the
// article now agrees with the noun ("an organization listing", 2026-10-05)
// and a place is a place, never a venue (owner Q14, 2026-10-17). An arrival
// area is not a listing: its report says "Getting there", the name the
// web app's report queue gives it (`reportsSubjectArrivalArea`). The
// reviewer's note is staff free text and stays verbatim.
//
// Spanish vocabulary matches the web app's report queue (es.ts `reports*`):
// "reporte" report, "listado" listing, "lugar" place, "grupo" organization,
// "Cómo llegar" Getting there; the reason labels are its `reportsReason*`
// labels, lowercased.
// ─────────────────────────────────────────────────────────────────────────────

export type EntityReportSubject =
  | "PLACE"
  | "HUMAN"
  | "ORGANIZATION"
  | "ARRIVAL_AREA";

export type EntityReportReasonKey =
  | "CLOSED_OR_GONE"
  | "INCORRECT_INFO"
  | "DUPLICATE"
  | "INAPPROPRIATE"
  | "SPAM"
  | "IMPERSONATION"
  | "OTHER";

export type EntityReportVerdictKey = "RESOLVED" | "DISMISSED";

export type EntityReportCopy = {
  /**
   * What was reported, as the noun phrase the bodies drop in whole ("a place
   * listing", "un listado de lugar"). An arrival area is not a listing, so
   * the phrase, not the template, carries the word.
   */
  readonly subject: { readonly [S in EntityReportSubject]: string };
  readonly reason: { readonly [R in EntityReportReasonKey]: string };
  readonly submitted: {
    /** "New listing report", or the arrival-area wording for that subject. */
    readonly title: (subject: EntityReportSubject) => string;
    readonly body: (v: { subject: string; reason: string }) => string;
    readonly reviewLabel: string;
  };
  readonly reviewed: {
    readonly title: (verdict: EntityReportVerdictKey) => string;
    readonly body: (v: {
      verdict: EntityReportVerdictKey;
      subject: string;
      reviewNote: string | null;
    }) => string;
  };
};

export const ENTITY_REPORT_COPY: {
  readonly [L in NotificationLocale]: EntityReportCopy;
} = {
  en: {
    subject: {
      PLACE: "a place listing",
      HUMAN: "a profile listing",
      ORGANIZATION: "an organization listing",
      ARRIVAL_AREA: "a parking, drop-off or load-in area",
    },
    reason: {
      CLOSED_OR_GONE: "closed or gone",
      INCORRECT_INFO: "incorrect info",
      DUPLICATE: "duplicate",
      INAPPROPRIATE: "inappropriate",
      SPAM: "spam",
      IMPERSONATION: "impersonation",
      OTHER: "other",
    },
    submitted: {
      title: (subject) =>
        subject === "ARRIVAL_AREA"
          ? "New Getting there report"
          : "New listing report",
      body: ({ subject, reason }) =>
        `A visitor reported ${subject} (${reason}).`,
      reviewLabel: "Review report",
    },
    reviewed: {
      title: (verdict) =>
        verdict === "RESOLVED"
          ? "Your report was resolved"
          : "Your report was reviewed",
      body: ({ verdict, subject, reviewNote }) => {
        const parts = [
          verdict === "RESOLVED"
            ? `Your report on ${subject} was reviewed and resolved.`
            : `Your report on ${subject} was reviewed and no action was taken.`,
        ];
        if (reviewNote) parts.push(`Reviewer note: ${reviewNote}`);
        return parts.join(" ");
      },
    },
  },
  es: {
    subject: {
      PLACE: "un listado de lugar",
      HUMAN: "un listado de perfil",
      ORGANIZATION: "un listado de grupo",
      ARRIVAL_AREA: "un área de estacionamiento, descenso o carga",
    },
    reason: {
      CLOSED_OR_GONE: "cerrado o desaparecido",
      INCORRECT_INFO: "información incorrecta",
      DUPLICATE: "duplicado",
      INAPPROPRIATE: "inapropiado",
      SPAM: "spam",
      IMPERSONATION: "suplantación de identidad",
      OTHER: "otro",
    },
    submitted: {
      title: (subject) =>
        subject === "ARRIVAL_AREA"
          ? "Nuevo reporte de Cómo llegar"
          : "Nuevo reporte de listado",
      body: ({ subject, reason }) =>
        `Alguien reportó ${subject} (${reason}).`,
      reviewLabel: "Revisar reporte",
    },
    reviewed: {
      title: (verdict) =>
        verdict === "RESOLVED"
          ? "Tu reporte se resolvió"
          : "Revisamos tu reporte",
      body: ({ verdict, subject, reviewNote }) => {
        const parts = [
          verdict === "RESOLVED"
            ? `Revisamos tu reporte sobre ${subject} y lo resolvimos.`
            : `Revisamos tu reporte sobre ${subject} y no tomamos ninguna medida.`,
        ];
        if (reviewNote) parts.push(`Nota de revisión: ${reviewNote}`);
        return parts.join(" ");
      },
    },
  },
};
