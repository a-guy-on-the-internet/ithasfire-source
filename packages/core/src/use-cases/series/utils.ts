import type {
  EventSeriesDefaults,
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
  EventSeriesSchedule,
  TemplateLocation,
} from "@th/types";
import type {
  SeriesDefaults,
  SeriesDTO,
  SeriesOccurrenceDTO,
  SeriesSchedule,
} from "./schemas";

/** seriesDefaultsSchema.titlePrefix cap (plainTextRequired(120)). */
export const SERIES_DEFAULTS_TITLE_PREFIX_MAX = 120;
/** seriesDefaultsSchema locationSchema freeform addressText cap (plainTextRequired(200)). */
export const SERIES_DEFAULTS_ADDRESS_TEXT_MAX = 200;

/**
 * Clamp an event title into the `Series.defaults.titlePrefix` bound. Event
 * titles allow more characters (140) than seriesDefaultsSchema.titlePrefix
 * (120), and plainTextRequired THROWS on overflow rather than truncating —
 * so writing an unclamped title poisons the stored defaults JSON and every
 * subsequent eventSeriesDtoSchema.parse (listEventSeries, admin surfaces)
 * explodes for that owner. Returns null when nothing usable survives the
 * clamp (callers keep their prior value or omit the key).
 */
export function clampSeriesDefaultsTitlePrefix(title: string): string | null {
  const clamped = title.slice(0, SERIES_DEFAULTS_TITLE_PREFIX_MAX).trim();
  return clamped.length > 0 ? clamped : null;
}

/**
 * Whether a derived location fits the seriesDefaultsSchema location bounds:
 * freeform addressText caps at 200 while events allow 280, and the schema
 * throws on overflow (same poisoned-defaults failure mode as titlePrefix).
 * Truncating an address would corrupt it, so callers KEEP their prior value
 * (or omit) when this returns false — never abort the surrounding mutation
 * over a defaults refresh.
 */
export function fitsSeriesDefaultsLocation(
  location: TemplateLocation | null,
): boolean {
  if (!location || location.kind !== "freeform") {
    return true;
  }
  return location.addressText.length <= SERIES_DEFAULTS_ADDRESS_TEXT_MAX;
}

export function normalizeSchedule(
  schedule: SeriesSchedule,
): EventSeriesSchedule {
  const normalized: EventSeriesSchedule = {
    kind: schedule.kind,
    rrule: schedule.rrule ?? null,
    dtstart: schedule.dtstart ?? null,
    until: schedule.until ?? null,
    dates: schedule.dates ?? null,
    windowStart: schedule.windowStart ?? null,
    windowEnd: schedule.windowEnd ?? null,
    maxOccurrencesPerExpand: schedule.maxOccurrencesPerExpand ?? 100,
  };

  if (normalized.kind === "RRULE") {
    normalized.dates = null;
  } else {
    normalized.rrule = null;
    normalized.dtstart = null;
    normalized.until = null;
  }

  if (normalized.dates) {
    normalized.dates = [...normalized.dates].sort();
  }

  return normalized;
}

export function normalizeDefaults(
  defaults: SeriesDefaults | undefined,
): EventSeriesDefaults | null {
  if (!defaults) {
    return null;
  }

  const {
    titlePrefix,
    location,
    categories,
    types,
    attributes,
    feePolicyId,
    payoutTermsDraft,
    ticketTypes,
  } = defaults;

  const hasValues =
    typeof titlePrefix === "string" ||
    !!location ||
    (categories && categories.length > 0) ||
    (types && types.length > 0) ||
    (attributes && attributes.length > 0) ||
    typeof feePolicyId === "string" ||
    !!payoutTermsDraft ||
    (ticketTypes && ticketTypes.length > 0);

  if (!hasValues) {
    return null;
  }

  return {
    titlePrefix: titlePrefix ?? null,
    location: location ?? null,
    categories: categories ?? null,
    types: types ?? null,
    attributes: attributes ?? null,
    feePolicyId: feePolicyId ?? null,
    payoutTermsDraft: payoutTermsDraft ?? null,
    agreementDraft: payoutTermsDraft ?? null,
    ticketTypes: ticketTypes ?? null,
  } satisfies EventSeriesDefaults;
}

export function mapSeriesRecordToDto(record: EventSeriesRecord): SeriesDTO {
  const schedule: SeriesSchedule = {
    kind: record.schedule.kind,
    rrule: record.schedule.rrule ?? undefined,
    dtstart: record.schedule.dtstart ?? undefined,
    until: record.schedule.until ?? undefined,
    dates: record.schedule.dates ?? undefined,
    windowStart: record.schedule.windowStart ?? undefined,
    windowEnd: record.schedule.windowEnd ?? undefined,
    maxOccurrencesPerExpand: record.schedule.maxOccurrencesPerExpand ?? 100,
  };

  const defaults = record.defaults
    ? {
        titlePrefix: record.defaults.titlePrefix ?? undefined,
        location: record.defaults.location ?? undefined,
        categories: record.defaults.categories ?? undefined,
        types: record.defaults.types ?? undefined,
        attributes: record.defaults.attributes ?? undefined,
        feePolicyId: record.defaults.feePolicyId ?? undefined,
        payoutTermsDraft:
          record.defaults.payoutTermsDraft ??
          record.defaults.agreementDraft ??
          undefined,
        ticketTypes: record.defaults.ticketTypes ?? undefined,
      }
    : undefined;

  return {
    id: record.id,
    ownerScope: record.ownerScope,
    ownerId: record.ownerId,
    name: record.name,
    description: record.description,
    active: record.active,
    timezone: record.timezone,
    schedule,
    templateId: record.templateId,
    defaults: defaults ?? null,
    createdByHumanId: record.createdByHumanId,
    updatedByHumanId: record.updatedByHumanId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  } satisfies SeriesDTO;
}

export function mapOccurrenceRecordToDto(
  record: EventSeriesOccurrenceRecord,
): SeriesOccurrenceDTO {
  const overrides = record.overrides
    ? {
        title: record.overrides.title ?? undefined,
        location: record.overrides.location ?? undefined,
        types: record.overrides.types ?? undefined,
        attributes: record.overrides.attributes ?? undefined,
        manual: record.overrides.manual ?? undefined,
        skipNote: record.overrides.skipNote ?? undefined,
        note: record.overrides.note ?? undefined,
      }
    : null;

  return {
    id: record.id,
    seriesId: record.seriesId,
    ordinal: record.ordinal,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    status: record.status,
    eventId: record.eventId,
    overrides,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } satisfies SeriesOccurrenceDTO;
}
