import type { NotificationLocale } from "../locale";

// ─────────────────────────────────────────────────────────────────────────────
// In-app copy for the claim-venue notices (places/_shared/claim-notifications
// .ts), one entry per `NotificationLocale` (pattern: ./rsvp.ts). In-app only:
// these notices have no email or push.
//
// The English is exactly what the producer stored before it stored a
// template; do not reword it (stored rows and their re-render must agree).
//
// The venue's name and the reviewer's note are free text: verbatim. Spanish
// follows the app's claim flow ("reclamación", "disputa") but says "lugar",
// never "sede"; an owner or reviewer is never gendered ("quien", "tu
// propiedad", "Nota de revisión").
// ─────────────────────────────────────────────────────────────────────────────

type Decision = "APPROVED" | "REJECTED";

// ── place.claim-received (to platform admins) ────────────────────────────────

export type PlaceClaimReceivedCopy = {
  readonly claimTitle: string;
  readonly claimBody: (v: { placeName: string }) => string;
  readonly disputeTitle: string;
  readonly disputeBody: (v: { placeName: string }) => string;
  readonly reviewLabel: string;
};

export const PLACE_CLAIM_RECEIVED_COPY: {
  readonly [L in NotificationLocale]: PlaceClaimReceivedCopy;
} = {
  en: {
    claimTitle: "New place ownership claim",
    claimBody: ({ placeName }) =>
      `Someone claimed "${placeName}" and is awaiting review.`,
    disputeTitle: "New place ownership dispute",
    disputeBody: ({ placeName }) =>
      `A dispute was filed against the verified owner of "${placeName}".`,
    reviewLabel: "Review claim",
  },
  es: {
    claimTitle: "Nueva reclamación de un lugar",
    claimBody: ({ placeName }) =>
      `Alguien reclamó «${placeName}» y está pendiente de revisión.`,
    disputeTitle: "Nueva disputa por un lugar",
    disputeBody: ({ placeName }) =>
      `Se presentó una disputa sobre la propiedad verificada de «${placeName}».`,
    reviewLabel: "Revisar reclamación",
  },
};

// ── place.claim-decided / place.dispute-decided (to the claimant) ────────────

export type PlaceDecisionCopy = {
  readonly title: (v: { decision: Decision }) => string;
  /** The opening sentence; the whole body when there is no note. */
  readonly lead: (v: { placeName: string; decision: Decision }) => string;
  readonly note: (notes: string) => string;
  readonly viewLabel: string;
};

const ES_NOTE = (notes: string) => `Nota de revisión: ${notes}`;
const EN_NOTE = (notes: string) => `Reviewer note: ${notes}`;

export const PLACE_CLAIM_DECIDED_COPY: {
  readonly [L in NotificationLocale]: PlaceDecisionCopy;
} = {
  en: {
    title: ({ decision }) =>
      decision === "APPROVED" ? "Place claim approved" : "Place claim declined",
    lead: ({ placeName, decision }) =>
      decision === "APPROVED"
        ? `Your claim on "${placeName}" was approved — you now own this place.`
        : `Your claim on "${placeName}" was not approved.`,
    note: EN_NOTE,
    viewLabel: "View place",
  },
  es: {
    title: ({ decision }) =>
      decision === "APPROVED"
        ? "Reclamación del lugar aprobada"
        : "Reclamación del lugar no aprobada",
    lead: ({ placeName, decision }) =>
      decision === "APPROVED"
        ? `Tu reclamación de «${placeName}» fue aprobada — ahora este lugar es tuyo.`
        : `Tu reclamación de «${placeName}» no fue aprobada.`,
    note: ES_NOTE,
    viewLabel: "Ver lugar",
  },
};

export const PLACE_DISPUTE_DECIDED_COPY: {
  readonly [L in NotificationLocale]: PlaceDecisionCopy;
} = {
  en: {
    title: ({ decision }) =>
      decision === "APPROVED"
        ? "Ownership dispute approved"
        : "Ownership dispute declined",
    lead: ({ placeName, decision }) =>
      decision === "APPROVED"
        ? `Your ownership dispute on "${placeName}" was approved — you now own this place.`
        : `Your ownership dispute on "${placeName}" was not approved.`,
    note: EN_NOTE,
    viewLabel: "View place",
  },
  es: {
    title: ({ decision }) =>
      decision === "APPROVED"
        ? "Disputa de propiedad aprobada"
        : "Disputa de propiedad no aprobada",
    lead: ({ placeName, decision }) =>
      decision === "APPROVED"
        ? `Tu disputa de propiedad sobre «${placeName}» fue aprobada — ahora este lugar es tuyo.`
        : `Tu disputa de propiedad sobre «${placeName}» no fue aprobada.`,
    note: ES_NOTE,
    viewLabel: "Ver lugar",
  },
};

/**
 * Lead, plus the reviewer's note on a rejection only (an approval never shows
 * it — that is what the producer always did).
 */
export function placeDecisionBody(
  copy: PlaceDecisionCopy,
  v: { placeName: string; decision: Decision; reviewerNotes: string | null },
): string {
  const parts = [copy.lead(v)];
  if (v.decision !== "APPROVED" && v.reviewerNotes) {
    parts.push(copy.note(v.reviewerNotes));
  }
  return parts.join(" ");
}

// ── place.ownership-transferred (to the previous owner) ──────────────────────

export type PlaceOwnershipTransferredCopy = {
  readonly title: string;
  readonly body: (v: { placeName: string }) => string;
  readonly viewLabel: string;
};

export const PLACE_OWNERSHIP_TRANSFERRED_COPY: {
  readonly [L in NotificationLocale]: PlaceOwnershipTransferredCopy;
} = {
  en: {
    title: "Place ownership transferred",
    body: ({ placeName }) =>
      `Following an ownership dispute review, your ownership of "${placeName}" was transferred to another party.`,
    viewLabel: "View place",
  },
  es: {
    title: "Propiedad del lugar transferida",
    body: ({ placeName }) =>
      `Tras revisar una disputa de propiedad, tu propiedad de «${placeName}» se transfirió a otra parte.`,
    viewLabel: "Ver lugar",
  },
};

// ── place.dispute-filed (to the current owner) ───────────────────────────────

export type PlaceDisputeFiledCopy = {
  readonly title: string;
  readonly body: (v: { placeName: string }) => string;
  readonly viewLabel: string;
};

export const PLACE_DISPUTE_FILED_COPY: {
  readonly [L in NotificationLocale]: PlaceDisputeFiledCopy;
} = {
  en: {
    title: "Ownership dispute filed",
    body: ({ placeName }) =>
      `Someone filed a dispute contesting your ownership of "${placeName}". A platform admin will review it.`,
    viewLabel: "View place",
  },
  es: {
    title: "Se presentó una disputa de propiedad",
    body: ({ placeName }) =>
      `Alguien presentó una disputa sobre tu propiedad de «${placeName}». Nuestro equipo la revisará.`,
    viewLabel: "Ver lugar",
  },
};
