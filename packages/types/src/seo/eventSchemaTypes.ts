/**
 * Single source of truth for the schema.org Event `@type` values this platform
 * is willing to emit in event JSON-LD.
 *
 * Every entry is a real subtype of schema.org/Event, so emitting one in place
 * of the plain `Event` is strictly additive for SEO — a crawler that doesn't
 * recognise the subtype still treats it as an Event, while Google can surface
 * the richer type (e.g. music-event rich results for `MusicEvent`).
 *
 * The mapping from a platform category to one of these types is data-driven
 * (`Category.seoType`) and edited by admins. Because the column is a plain
 * string, this allowlist is the ONLY gate: the SEO builder falls back to
 * `"Event"` for anything not present here, and the admin editor rejects writes
 * of values outside this set. Keep both paths pointed at this constant.
 */
export const EVENT_SCHEMA_TYPES = [
  "Event",
  "MusicEvent",
  "ComedyEvent",
  "TheaterEvent",
  "DanceEvent",
  "ScreeningEvent",
  "Festival",
  "FoodEvent",
  "SocialEvent",
  "VisualArtsEvent",
  "LiteraryEvent",
  "EducationEvent",
  "ExhibitionEvent",
  "ChildrensEvent",
  "SportsEvent",
] as const;

export type EventSchemaType = (typeof EVENT_SCHEMA_TYPES)[number];

/** The default `@type` when a category has no (or an unknown) override. */
export const DEFAULT_EVENT_SCHEMA_TYPE: EventSchemaType = "Event";

const EVENT_SCHEMA_TYPE_SET: ReadonlySet<string> = new Set(EVENT_SCHEMA_TYPES);

/**
 * Type guard: is `value` one of the supported schema.org Event subtypes?
 * Used by both the SEO builder (fall back to `Event` when false) and the
 * admin editor validation (reject the write when false).
 */
export function isValidEventSchemaType(
  value: unknown,
): value is EventSchemaType {
  return typeof value === "string" && EVENT_SCHEMA_TYPE_SET.has(value);
}
