export const HOST_ATTESTATION_VERSION = "2026-10-17";

export const HOST_ATTESTATION_FIELDS = [
  "legalRightToHost",
  "zoningAndNoiseCompliance",
  "alcoholCompliance",
  "taxResponsibility",
  "organizerFaqReviewed",
] as const;

export type HostAttestationField = (typeof HOST_ATTESTATION_FIELDS)[number];

export const HOST_ATTESTATION_TEXT = {
  legalRightToHost:
    "I have the legal right to host this event at the location stated. " +
    "If the place is private property, I am the owner or have explicit " +
    "written permission from the owner. If public, I have any required permits.",

  zoningAndNoiseCompliance:
    "This event complies with local zoning, occupancy, and noise ordinances. " +
    "I understand that complaints from neighbours or enforcement actions by " +
    "local authorities are my responsibility, not Ithas Fire's.",

  alcoholCompliance:
    "All alcohol service at this event — whether sold by me, provided by " +
    "a caterer or vendor, given to attendees, or accepted by donation — " +
    "complies with applicable state and local law, including any required " +
    "licenses or permits. I am responsible for verifying my own legal " +
    "status (and that of any vendor I engage). Ithas Fire does not act as " +
    "a seller, distributor, or facilitator of alcohol.",

  taxResponsibility:
    "I am responsible for any income, sales, or admissions taxes owed on the " +
    "revenue from this event. Ithas Fire will issue a 1099-K where required " +
    "by federal or state law; the underlying tax obligation is mine.",

  organizerFaqReviewed:
    "I have read the Ithas Fire Organizer FAQ and understand the platform's " +
    "policies on refunds, chargebacks, cancellation, and payouts.",
} satisfies Record<HostAttestationField, string>;