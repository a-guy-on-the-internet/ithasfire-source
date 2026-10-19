/**
 * Helpers for the /moderate/images flagged-image queue (image-moderation spec
 * FR-008). Kept in a plain module (no React) so the severity mapping and
 * deep-link building are unit-testable without rendering the queue.
 */

export type SeverityBucket = "none" | "low" | "high" | "severe";

/** Subset of the shared Badge `tone` union used by severity chips. */
export type ChipTone = "danger" | "warning" | "neutral";

export type FlaggedCategory = "SEXUAL" | "VIOLENCE" | "HATE" | "SELF_HARM";

export type FlaggedSubjectType = "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";

/**
 * Azure Content Safety's four-severity scale is 0 / 2 / 4 / 6. Map any numeric
 * severity into a labelled bucket using ranges (not exact matches) so an
 * adapter that ever emits an eight-level scale still buckets sanely:
 *   0-1 → none, 2-3 → low, 4-5 → high, 6+ → severe.
 */
export function severityBucket(severity: number): SeverityBucket {
  if (severity >= 6) return "severe";
  if (severity >= 4) return "high";
  if (severity >= 2) return "low";
  return "none";
}

/** i18n key suffix for a severity bucket (moderation.imagesSeverity*). */
export function severityLabelKey(severity: number): string {
  switch (severityBucket(severity)) {
    case "severe":
      return "moderation.imagesSeveritySevere";
    case "high":
      return "moderation.imagesSeverityHigh";
    case "low":
      return "moderation.imagesSeverityLow";
    default:
      return "moderation.imagesSeverityNone";
  }
}

/** i18n key for a category label (moderation.imagesCategory*). */
export function categoryLabelKey(category: FlaggedCategory): string {
  switch (category) {
    case "SEXUAL":
      return "moderation.imagesCategorySexual";
    case "VIOLENCE":
      return "moderation.imagesCategoryViolence";
    case "HATE":
      return "moderation.imagesCategoryHate";
    case "SELF_HARM":
      return "moderation.imagesCategorySelfHarm";
  }
}

/**
 * Chip tone for a severity — text labels carry the meaning (never colour-only),
 * this only reinforces triage. `none` stays neutral so the zero-severity
 * categories recede.
 */
export function severityTone(severity: number): ChipTone {
  switch (severityBucket(severity)) {
    case "severe":
    case "high":
      return "danger";
    case "low":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * Best-effort deep link to the flagged image's owning entity. EVENT: the
 * public event route resolves a bare eventId via its UUID fallback
 * (redirecting to the canonical slug), so `/events/{id}` is a working link.
 * PLACE (a community moderator's page image on an unowned place): the
 * id-keyed place route `/places/id/{placeId}`. HUMAN / ORGANIZATION have no
 * clean public URL from an id alone yet — return null and let the caller
 * render the type + id as plain text.
 */
export function buildSubjectHref(
  subjectType: FlaggedSubjectType | null,
  subjectId: string | null,
): string | null {
  if (!subjectId) return null;
  if (subjectType === "EVENT") return `/events/${subjectId}`;
  if (subjectType === "PLACE") {
    return `/places/id/${encodeURIComponent(subjectId)}`;
  }
  return null;
}
