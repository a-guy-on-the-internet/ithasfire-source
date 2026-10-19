/**
 * Display-order + labeling metadata for EventEditSuggestion field diffs —
 * shared by the community moderator queue (/moderate/suggestions) and the
 * owner-side suggestion inboxes (FR-016).
 *
 * Mirrors SUGGESTION_EDITABLE_FIELDS in core's suggestion-fields.ts (FR-007);
 * the subset tagged material mirrors MATERIAL_SUGGESTION_FIELDS (FR-013:
 * schedule + venue). Kept as local constants so the review UIs stay
 * dependency-light; unknown keys from the server still render (raw key).
 */

export const SUGGESTION_FIELD_ORDER = [
  "title",
  "content",
  "startsAt",
  "endsAt",
  "timezone",
  "addressText",
  "countryCode",
  "region",
  "locality",
  "postalCode",
  "lat",
  "lng",
  "categoryId",
  "heroImageId",
  "ageLimit",
] as const;

export const MATERIAL_SUGGESTION_FIELDS: ReadonlySet<string> = new Set([
  "startsAt",
  "endsAt",
  "addressText",
  "countryCode",
  "region",
  "locality",
  "postalCode",
  "lat",
  "lng",
]);

export const SUGGESTION_FIELD_LABEL_KEYS: Record<string, string> = {
  title: "moderation.fieldTitle",
  content: "moderation.fieldContent",
  startsAt: "moderation.fieldStartsAt",
  endsAt: "moderation.fieldEndsAt",
  timezone: "moderation.fieldTimezone",
  addressText: "moderation.fieldAddressText",
  countryCode: "moderation.fieldCountryCode",
  region: "moderation.fieldRegion",
  locality: "moderation.fieldLocality",
  postalCode: "moderation.fieldPostalCode",
  lat: "moderation.fieldLat",
  lng: "moderation.fieldLng",
  categoryId: "moderation.fieldCategoryId",
  heroImageId: "moderation.fieldHeroImageId",
  ageLimit: "moderation.fieldAgeLimit",
};

/** Field keys present in the diff, in whitelist order (unknown keys last). */
export function orderedSuggestionFieldKeys(
  fields: Record<string, unknown>,
): string[] {
  const present = Object.keys(fields).filter(
    (key) => fields[key] !== undefined,
  );
  const known = SUGGESTION_FIELD_ORDER.filter((key) => present.includes(key));
  const unknown = present.filter(
    (key) => !(SUGGESTION_FIELD_ORDER as readonly string[]).includes(key),
  );
  return [...known, ...unknown];
}
