import type { NotificationLocale } from "../locale";
import { COMMON_COPY } from "./common";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the community edit-suggestion notices
// (community/_shared/suggestion-notifications.ts), one entry per
// `NotificationLocale` (pattern: ./rsvp.ts). In-app only: no email or push.
//
// The English is exactly what the producer stored before it stored a
// template; do not reword it.
//
// The event title and the reviewer's note are free text, and the skipped
// field names are the producer's own keys: all verbatim. Spanish never
// genders the submitter or the reviewer ("Alguien", "Nota de revisión").
// ─────────────────────────────────────────────────────────────────────────────

// ── community.suggestion-received (to the reviewers) ─────────────────────────

export type SuggestionReceivedCopy = {
  readonly title: string;
  readonly body: (v: { eventTitle: string }) => string;
  readonly reviewLabel: string;
};

export const SUGGESTION_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: SuggestionReceivedCopy;
} = {
  en: {
    title: "New edit suggestion",
    body: ({ eventTitle }) => `A visitor suggested changes to "${eventTitle}".`,
    reviewLabel: "Review suggestion",
  },
  es: {
    title: "Nueva sugerencia de cambios",
    body: ({ eventTitle }) => `Alguien sugirió cambios en «${eventTitle}».`,
    reviewLabel: "Revisar sugerencia",
  },
};

// ── community.suggestion-reviewed (to the submitter) ─────────────────────────

export type SuggestionReviewedCopy = {
  readonly approvedTitle: string;
  readonly approvedLead: (v: { eventTitle: string }) => string;
  readonly skippedFields: (fields: string) => string;
  readonly rejectedTitle: string;
  readonly rejectedLead: (v: { eventTitle: string }) => string;
  readonly note: (note: string) => string;
  readonly viewLabel: string;
};

export const SUGGESTION_REVIEWED_COPY: {
  readonly [L in NotificationLocale]: SuggestionReviewedCopy;
} = {
  en: {
    approvedTitle: "Your suggestion was approved",
    approvedLead: ({ eventTitle }) =>
      `Your suggested changes to "${eventTitle}" were approved and applied.`,
    skippedFields: (fields) =>
      `Some fields had changed since you submitted and were skipped: ${fields}.`,
    rejectedTitle: "Your suggestion was reviewed",
    rejectedLead: ({ eventTitle }) =>
      `Your suggested changes to "${eventTitle}" were reviewed but not applied.`,
    note: (note) => `Reviewer note: ${note}`,
    viewLabel: COMMON_COPY.en.viewEvent,
  },
  es: {
    approvedTitle: "Tu sugerencia fue aprobada",
    approvedLead: ({ eventTitle }) =>
      `Tus cambios sugeridos para «${eventTitle}» se aprobaron y aplicaron.`,
    skippedFields: (fields) =>
      `Algunos campos cambiaron después de que enviaste la sugerencia, así que se omitieron: ${fields}.`,
    rejectedTitle: "Tu sugerencia fue revisada",
    rejectedLead: ({ eventTitle }) =>
      `Tus cambios sugeridos para «${eventTitle}» se revisaron, pero no se aplicaron.`,
    note: (note) => `Nota de revisión: ${note}`,
    viewLabel: COMMON_COPY.es.viewEvent,
  },
};

/** The in-app body: lead, skipped fields (approvals only), then the note. */
export function suggestionReviewedBody(
  copy: SuggestionReviewedCopy,
  v: {
    eventTitle: string;
    decision: "APPROVE" | "REJECT";
    reviewNote: string | null;
    conflictedFields: readonly string[];
  },
): string {
  if (v.decision === "APPROVE") {
    const parts = [copy.approvedLead(v)];
    if (v.conflictedFields.length > 0) {
      parts.push(copy.skippedFields(v.conflictedFields.join(", ")));
    }
    if (v.reviewNote) parts.push(copy.note(v.reviewNote));
    return parts.join(" ");
  }
  const parts = [copy.rejectedLead(v)];
  if (v.reviewNote) parts.push(copy.note(v.reviewNote));
  return parts.join(" ");
}
