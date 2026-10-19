import { z } from "zod";

import type {
  CommunityEditableFieldValues,
  EventRecord,
} from "@th/ports/repos/events";
import { suggestionRejection } from "../../community/_shared/suggestion-rejection";
import { parseInput } from "../../../lib/io";
import {
  plainTextOptional,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";

/**
 * FR-007 whitelist machinery for event edit suggestions
 * (docs/specs/2026-07-01/completed/community-managed-event-listings.spec.yaml).
 *
 * A suggestion may only carry the whitelisted fields below. Money / tax /
 * payout / ticket / ownership / status fields are NEVER accepted, on ANY
 * event kind (suggestions are universal per FR-006). `geohash6` is
 * deliberately absent — it is re-derived server-side from lat/lng.
 *
 * `content` is the event body (full EventBody JSON). Its DEEP validation +
 * embed-allowlist sanitization lives in `event-body-sanitizer.ts` and must be
 * run by the submit AND review use-cases (never trust the stored Json); this
 * module only whitelists the key.
 */
export const SUGGESTION_EDITABLE_FIELDS = [
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

export type SuggestionEditableField =
  (typeof SUGGESTION_EDITABLE_FIELDS)[number];

/**
 * The address + geo fields form ONE material group (FR-007/FR-013): a venue
 * move is a single semantic change even when only some of its columns move.
 *
 * Conflict semantics for the group (FR-009): when a suggestion proposes ANY
 * of these fields, the group is conflict-checked AS A WHOLE — if any field in
 * the group drifted between the suggestion's baseVersion and the current
 * event, EVERY proposed geo field is flagged conflicted (and none of them
 * apply). Rationale: applying a partial geo diff on top of someone else's
 * venue change could stitch together an address that never existed (e.g. new
 * street + old postal code). Non-geo fields keep independent per-field
 * conflict checks, and applied values are still stored/written per-field.
 */
export const GEO_GROUP_FIELDS = [
  "addressText",
  "countryCode",
  "region",
  "locality",
  "postalCode",
  "lat",
  "lng",
] as const satisfies readonly SuggestionEditableField[];

/**
 * startsAt/endsAt form ONE conflict group for the same reason as
 * {@link GEO_GROUP_FIELDS}: applying a partial schedule diff on top of someone
 * else's schedule change could stitch together a schedule that never existed —
 * and, worse than geo, can VIOLATE the endsAt-after-startsAt invariant.
 * `ensureProposedScheduleValid` runs on the FULL proposed pair BEFORE conflict
 * filtering, so if one bound conflicts away while the other applies, the
 * surviving bound was never checked against the event's CURRENT other bound
 * (e.g. current Jul 10→Jul 12; suggestion proposes Jul 2→Jul 3 from a stale
 * base: startsAt conflicts, a lone endsAt Jul 3 would apply → Jul 10→Jul 3).
 * Grouped conflict detection means one drifted bound conflicts BOTH proposed
 * bounds, so the pair the schedule check validated is applied atomically or
 * not at all.
 */
export const SCHEDULE_GROUP_FIELDS = [
  "startsAt",
  "endsAt",
] as const satisfies readonly SuggestionEditableField[];

/**
 * Fields whose change is "material" to attendees (FR-013): schedule and
 * venue. An approved suggestion that changes any of these stamps
 * `material: true` on its applied AuditLog row (delivery of notifications is
 * the separate change-notification spec). Non-material: title, content
 * (body), categoryId, heroImageId, ageLimit, timezone (instants are stored
 * UTC, so a timezone edit is presentational).
 */
export const MATERIAL_SUGGESTION_FIELDS = [
  ...SCHEDULE_GROUP_FIELDS,
  ...GEO_GROUP_FIELDS,
] as const satisfies readonly SuggestionEditableField[];

/**
 * The place link (`Event.placeId`). MODERATOR DIRECT EDIT ONLY: it is
 * deliberately NOT in {@link SUGGESTION_EDITABLE_FIELDS}, so
 * {@link parseSuggestionFields} rejects it as `unsupported_fields` on every
 * public suggestion. `updateCommunityListing` takes it out of the diff before
 * that parser runs and handles it itself.
 *
 * NOT material by itself (FR-013). Linking or unlinking a place at an
 * unchanged address tells attendees nothing they must act on, and a false
 * "venue changed" alert trains RSVPers to ignore the real one. A link that
 * also moves the address is material through the address/geo columns it
 * writes. The link is still recorded in the version history's `changes`.
 */
export const PLACE_LINK_FIELD = "placeId" as const;

const MATERIAL_FIELD_SET: ReadonlySet<string> = new Set(
  MATERIAL_SUGGESTION_FIELDS,
);
const GEO_GROUP_FIELD_SET: ReadonlySet<string> = new Set(GEO_GROUP_FIELDS);
const SCHEDULE_GROUP_FIELD_SET: ReadonlySet<string> = new Set(
  SCHEDULE_GROUP_FIELDS,
);
const EDITABLE_FIELD_SET: ReadonlySet<string> = new Set(
  SUGGESTION_EDITABLE_FIELDS,
);

/** Whether an approved change to `name` is material (FR-013). */
export function isMaterialField(name: string): boolean {
  return MATERIAL_FIELD_SET.has(name);
}

/** Whether an applied diff touching `changedFields` is material (FR-013). */
export function computeMaterial(changedFields: readonly string[]): boolean {
  return changedFields.some((field) => isMaterialField(field));
}

// ── Value schemas ────────────────────────────────────────────────────────────

/**
 * Accepts a Date instance (in-process callers) or an ISO datetime string
 * (transport / stored-Json re-validation) and yields a valid Date. Mirrors
 * `isoDateTimeSchema` in save-event-shared.ts.
 */
const suggestionInstantSchema = z
  .union([z.date(), z.string().trim()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(Date.parse(value));
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid datetime" });
      return z.NEVER;
    }
    return date;
  });

/**
 * IANA timezone validation — same runtime check the owned builder uses
 * (save-event-shared.ts `baseSaveEventInputSchema.timezone`): a zone is valid
 * iff Intl can construct a formatter for it.
 */
const suggestionTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "invalid timezone");

/**
 * Strict value rules for the whitelisted fields. All fields optional (a
 * suggestion is a partial diff) but see {@link parseSuggestionFields} for the
 * at-least-one-field and unknown-key gates. Value bounds mirror the owned
 * builder (`baseSaveEventInputSchema` / `locationSchema`) so a suggested
 * value is never accepted that the builder itself would reject:
 * title 1..140, addressText 1..280, region/locality ≤200, postalCode ≤20,
 * lat/lng ranges, ageLimit 0..99.
 *
 * PAIRING INVARIANT — lat/lng travel together or not at all: a diff carrying
 * exactly one of {lat, lng}, or one null and the other non-null, is invalid.
 * The adapter's `applyCommunityEdit` re-derives `geohash6` only when BOTH lat
 * and lng are non-null in the diff — a lone-lat diff (or a mixed null/number
 * pair) would silently desync the stored geohash from the pin. Enforced here
 * at the validation boundary (and again, belt-and-braces, in the adapter).
 */
export const suggestionFieldValuesSchema = z
  .object({
    title: plainTextRequired(140).optional(),
    /**
     * Full EventBody JSON (or null to clear). Deep-validated + sanitized
     * separately via `sanitizeEventBody` — enforced at submit AND apply.
     */
    content: z.unknown().nullable().optional(),
    startsAt: suggestionInstantSchema.optional(),
    /** Non-nullable to match the Event.endsAt column contract for edits. */
    endsAt: suggestionInstantSchema.optional(),
    timezone: suggestionTimezoneSchema.optional(),
    addressText: plainTextRequired(280).nullable().optional(),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, "must be a 2-letter ISO country code")
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    region: plainTextOptional(200).nullable().optional(),
    locality: plainTextOptional(200).nullable().optional(),
    postalCode: z.string().trim().max(20).nullable().optional(),
    lat: z.number().gte(-90).lte(90).nullable().optional(),
    lng: z.number().gte(-180).lte(180).nullable().optional(),
    categoryId: z.uuid().nullable().optional(),
    heroImageId: z.uuid().nullable().optional(),
    ageLimit: z.number().int().min(0).max(99).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "must be after startsAt",
      });
    }
    // lat/lng pairing invariant (see schema doc comment): both present or
    // both absent, and null only as a pair.
    if (latLngPairingViolated(value.lat, value.lng)) {
      ctx.addIssue({
        code: "custom",
        path: ["lng"],
        message: "lat and lng must be provided together (both set or both null)",
      });
    }
  });

/**
 * True when exactly one of {lat, lng} is provided, or one is null while the
 * other is a number. `undefined` = "not part of the diff".
 */
function latLngPairingViolated(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  if ((lat === undefined) !== (lng === undefined)) {
    return true;
  }
  if (lat === undefined || lng === undefined) {
    return false;
  }
  return (lat === null) !== (lng === null);
}

/**
 * Parse + whitelist a raw proposed-fields payload (FR-006/FR-007).
 *
 * - Any NON-whitelisted key (e.g. `admissionTaxRateBps`, `orgId`, `status`)
 *   REJECTS the whole payload with `EDIT_SUGGESTION_INVALID_FIELDS` — per the
 *   acceptance criteria we reject rather than silently strip, so a caller
 *   smuggling a forbidden field gets a hard error, not a partial apply.
 * - An empty diff (no whitelisted field with a defined value) is also
 *   rejected with `EDIT_SUGGESTION_INVALID_FIELDS`.
 * - Value-level violations reject with the standard `invalid_input` shape
 *   (same contract as every other use-case input).
 *
 * NOTE: `content` still requires `sanitizeEventBody` (schema + embed
 * allowlist). And when only ONE of {startsAt, endsAt} is proposed, the
 * submit/apply path MUST cross-check it against the event's effective other
 * bound — a lone endsAt before the current startsAt AND a lone startsAt
 * moved after the effective endsAt are equally invalid. The schema can only
 * enforce ordering when both bounds travel in the same diff.
 */
export function parseSuggestionFields(
  raw: unknown,
): CommunityEditableFieldValues {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw suggestionRejection("not_an_object");
  }

  const unknownKeys = Object.keys(raw).filter(
    (key) => !EDITABLE_FIELD_SET.has(key),
  );
  if (unknownKeys.length > 0) {
    throw suggestionRejection("unsupported_fields", unknownKeys);
  }

  // lat/lng pairing invariant (see suggestionFieldValuesSchema doc comment):
  // enforced pre-parse with the typed code so callers get a structural
  // whitelist error, not a generic invalid_input.
  const rawRecord = raw as Record<string, unknown>;
  const rawLat = rawRecord.lat as number | null | undefined;
  const rawLng = rawRecord.lng as number | null | undefined;
  if (
    (rawLat === undefined) !== (rawLng === undefined) ||
    (rawLat !== undefined &&
      rawLng !== undefined &&
      (rawLat === null) !== (rawLng === null))
  ) {
    throw suggestionRejection("lat_lng_must_pair", ["lat", "lng"]);
  }

  const parsed = parseInput(suggestionFieldValuesSchema, raw);

  const proposedFieldNames = SUGGESTION_EDITABLE_FIELDS.filter(
    (field) => parsed[field] !== undefined,
  );
  if (proposedFieldNames.length === 0) {
    throw suggestionRejection("empty_diff");
  }

  return parsed as CommunityEditableFieldValues;
}

// ── Base snapshot + conflict detection (FR-009) ──────────────────────────────

/**
 * Snapshot the whitelisted fields of an event at suggestion-draft time —
 * stored as the suggestion's `baseVersion` and later diffed against the
 * current event on APPROVE.
 *
 * - `content` (the EventBody Json) lives OUTSIDE `EventRecord` on read paths;
 *   pass the result of `repos.events.getContent({ eventId })`.
 * - `heroImageId`: `EventRecord` only exposes `heroImageUrl`, so the caller
 *   resolves the current hero IMAGE id (images repo) and passes it here.
 * - Dates are serialized to ISO strings so the snapshot round-trips through
 *   the Json column deterministically; {@link computeConflicts} compares
 *   date-likes by instant, so Date/ISO-string mixes are safe regardless.
 */
export function snapshotSuggestionBase(params: {
  event: EventRecord;
  /** Result of repos.events.getContent({ eventId }). */
  content: unknown | null;
  /** Current hero image id (resolved by the caller); null when no hero set. */
  heroImageId?: string | null;
}): Record<string, unknown> {
  const { event } = params;
  return {
    title: event.title,
    content: params.content ?? null,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    timezone: event.timezone,
    addressText: event.addressText ?? null,
    countryCode: event.countryCode ?? null,
    region: event.region ?? null,
    locality: event.locality ?? null,
    postalCode: event.postalCode ?? null,
    lat: event.lat ?? null,
    lng: event.lng ?? null,
    categoryId: event.categoryId ?? null,
    heroImageId: params.heroImageId ?? null,
    ageLimit: event.ageLimit ?? null,
  };
}

export interface SuggestionConflictResult {
  /**
   * The proposed values safe to apply (field → value). Per-field even for
   * the geo group — grouping affects conflict DETECTION only.
   */
  applicable: Record<string, unknown>;
  /** Field names skipped because the event drifted since `baseVersion`. */
  conflicted: string[];
}

/**
 * FR-009 conflict detection: a proposed field conflicts iff the CURRENT event
 * value differs from the suggestion's `baseVersion` value for that field —
 * i.e. someone else changed it after the suggestion was drafted. Conflicting
 * fields are skipped (surfaced to the reviewer); non-conflicting fields still
 * apply.
 *
 * Geo group: see {@link GEO_GROUP_FIELDS} — if ANY geo field is proposed and
 * ANY geo field drifted, the whole proposed geo subset conflicts.
 *
 * Schedule group: see {@link SCHEDULE_GROUP_FIELDS} — same grouping semantics
 * as geo, additionally protecting the endsAt-after-startsAt invariant (the
 * schedule validity check runs on the FULL pair before conflict filtering, so
 * a split pair must never be applied).
 *
 * Equality rules: null/undefined are equivalent; Date vs ISO-string compare
 * by instant; `content` (Json) compares by structural deep-equal.
 */
export function computeConflicts(params: {
  proposed: Record<string, unknown>;
  base: Record<string, unknown>;
  current: Record<string, unknown>;
}): SuggestionConflictResult {
  const { proposed, base, current } = params;

  const proposedFields = SUGGESTION_EDITABLE_FIELDS.filter(
    (field) => proposed[field] !== undefined,
  );

  const geoProposed = proposedFields.some((field) =>
    GEO_GROUP_FIELD_SET.has(field),
  );
  const geoGroupConflicted =
    geoProposed &&
    GEO_GROUP_FIELDS.some(
      (field) => !suggestionValuesEqual(base[field], current[field]),
    );

  const scheduleProposed = proposedFields.some((field) =>
    SCHEDULE_GROUP_FIELD_SET.has(field),
  );
  const scheduleGroupConflicted =
    scheduleProposed &&
    SCHEDULE_GROUP_FIELDS.some(
      (field) => !suggestionValuesEqual(base[field], current[field]),
    );

  const applicable: Record<string, unknown> = {};
  const conflicted: string[] = [];

  for (const field of proposedFields) {
    const isConflicted = GEO_GROUP_FIELD_SET.has(field)
      ? geoGroupConflicted
      : SCHEDULE_GROUP_FIELD_SET.has(field)
        ? scheduleGroupConflicted
        : !suggestionValuesEqual(base[field], current[field]);
    if (isConflicted) {
      conflicted.push(field);
    } else {
      applicable[field] = proposed[field];
    }
  }

  return { applicable, conflicted };
}

/**
 * Field-value equality for base/current snapshot comparison. Treats
 * null/undefined uniformly, compares date-likes by instant, and falls back to
 * structural deep-equal for Json values (event body content).
 */
export function suggestionValuesEqual(a: unknown, b: unknown): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) {
    return left === right;
  }

  if (left instanceof Date || right instanceof Date) {
    const leftTime = toInstant(left);
    const rightTime = toInstant(right);
    return leftTime !== null && rightTime !== null && leftTime === rightTime;
  }

  return deepEqual(left, right);
}

function toInstant(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : time;
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (
    typeof a === "object" &&
    typeof b === "object" &&
    a !== null &&
    b !== null
  ) {
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    // Keys with undefined values are treated as absent (Json round-trips
    // drop them anyway).
    const aKeys = Object.keys(aRecord).filter(
      (key) => aRecord[key] !== undefined,
    );
    const bKeys = Object.keys(bRecord).filter(
      (key) => bRecord[key] !== undefined,
    );
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every((key) => deepEqual(aRecord[key], bRecord[key]));
  }
  return false;
}
