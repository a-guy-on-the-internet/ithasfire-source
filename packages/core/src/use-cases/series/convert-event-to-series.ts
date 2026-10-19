import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  EventRecord,
  EventSeriesDefaults,
  EventSeriesOwnerScope,
  TemplateLocation,
} from "@th/types";
import { DateTime } from "luxon";
import rrulePkg from "rrule";

const { RRule } = rrulePkg;

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import {
  dateTimeToFloating,
  floatingToInstant,
} from "../events/_shared/rrule-floating-time";
import { ensureSeriesOwnerAccess } from "./permissions";
import {
  convertEventToSeriesInputSchema,
  convertEventToSeriesResultSchema,
  type ConvertEventToSeriesInput,
  type ConvertEventToSeriesResult,
  type SeriesSchedule,
} from "./schemas";
import {
  clampSeriesDefaultsTitlePrefix,
  fitsSeriesDefaultsLocation,
  normalizeSchedule,
} from "./utils";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;
const SERIES_NAME_MAX_LENGTH = 120;
/** Base name + up to 4 numeric-suffix retries: "Name", "Name (2)" … "Name (5)". */
const MAX_NAME_ATTEMPTS = 5;

export type ConvertEventToSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredConvertRecord = {
  payloadHash: string;
  response: ConvertEventToSeriesResult;
};

function buildIdempotencyKey(input: ConvertEventToSeriesInput): string {
  return `series:convert:${input.eventId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: ConvertEventToSeriesInput): string {
  const normalized = {
    eventId: input.eventId,
    name: input.name ?? null,
    schedule: normalizeSchedule(input.schedule),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function parseZoned(
  value: string | null | undefined,
  timezone: string,
): DateTime | null {
  if (!value) {
    return null;
  }
  const dt = DateTime.fromISO(value, { zone: timezone });
  if (!dt.isValid) {
    throw fail("INVALID_DATETIME");
  }
  return dt;
}

function clampCap(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(Math.max(value, 1), 500);
}

/**
 * Whether `instant` sits exactly ON the schedule grid (compared as instants,
 * never as strings). ISO strings in the schedule are interpreted in the
 * series timezone, mirroring expand-series / reconcile-series-schedule.
 *
 * This gate exists because reconcileSeriesSchedule treats any FUTURE
 * occurrence whose startsAt is not in the computed schedule set as orphaned
 * (GENERATED/PUBLISHED → DETACHED) — a converted event must land on the grid
 * or the next builder save silently detaches it.
 *
 * The check mirrors reconcile's computeNewTimestamps INCLUDING its
 * maxOccurrencesPerExpand cap: reconcile only materializes the first N
 * enumerated instants, so an instant beyond the cap would be orphaned on the
 * next reconcile even though the rule technically contains it. Enumerating
 * from dtstart is the conservative anchor — reconcile enumerates from its
 * (later or equal) window start, which can only DECREASE the event's index.
 */
function isInstantOnSchedule(
  schedule: SeriesSchedule,
  timezone: string,
  instant: Date,
): boolean {
  const t = instant.getTime();

  const windowStart = parseZoned(schedule.windowStart, timezone);
  if (windowStart && t < windowStart.toUTC().toMillis()) {
    return false;
  }
  const windowEnd = parseZoned(schedule.windowEnd, timezone);
  if (windowEnd && t > windowEnd.toUTC().toMillis()) {
    return false;
  }

  const cap = clampCap(schedule.maxOccurrencesPerExpand ?? 100);

  if (schedule.kind === "RRULE") {
    if (!schedule.rrule || !schedule.dtstart) {
      throw fail("SERIES_SCHEDULE_INVALID");
    }
    // `dtstart` / `until` as REAL instants, for the bounds checks against
    // `t` (also a real instant)...
    const dtstartDateTime = parseZoned(schedule.dtstart, timezone)!;
    const untilDateTime = schedule.until
      ? parseZoned(schedule.until, timezone)!
      : null;
    const dtstartMs = dtstartDateTime.toUTC().toMillis();
    const untilMs = untilDateTime ? untilDateTime.toUTC().toMillis() : null;

    if (t < dtstartMs) {
      return false;
    }
    if (untilMs !== null && t > untilMs) {
      return false;
    }

    // ...and as FLOATING wall-clock for the rule itself. `rrule` is
    // timezone-blind — it reads/writes a Date's UTC fields and treats them as
    // wall-clock — so feeding it real instants evaluates BYDAY/BYHOUR against
    // the UTC calendar and this gate would reject the very instants
    // reconcileSeriesSchedule now materializes. Both must agree or a
    // converted event is detached on the next builder save. See
    // `events/_shared/rrule-floating-time.ts`.
    const dtstartFloating = dateTimeToFloating(dtstartDateTime);
    if (!dtstartFloating) {
      // FAIL CLOSED, but not by returning false: `false` here surfaces as
      // EVENT_START_NOT_IN_SCHEDULE, which tells the organizer their date is
      // off the grid when the truth is that the schedule itself is unusable.
      throw fail("SERIES_SCHEDULE_INVALID");
    }
    const untilFloating = untilDateTime
      ? dateTimeToFloating(untilDateTime)
      : null;

    const ruleOptions = RRule.parseString(schedule.rrule);
    ruleOptions.dtstart = dtstartFloating;
    if (untilFloating) {
      ruleOptions.until = untilFloating;
    }
    const rule = new RRule(ruleOptions);

    let next = rule.after(new Date(dtstartFloating.getTime() - 1), true);
    let count = 0;
    while (next && count < cap) {
      // Back out of floating space before comparing with `t`.
      const instant = floatingToInstant(next, timezone);
      if (instant) {
        const ms = instant.getTime();
        if (untilMs !== null && ms > untilMs) {
          return false;
        }
        if (ms === t) {
          return true;
        }
        if (ms > t) {
          return false;
        }
      }
      next = rule.after(next, false);
      count += 1;
    }
    return false;
  }

  // FIXED_DATES: only the first `cap` distinct instants (ascending — the
  // stored schedule is normalized/sorted) survive a reconcile.
  const dates = schedule.dates ?? [];
  const sortedMs = [
    ...new Set(
      dates
        .map((iso) => parseZoned(iso, timezone)?.toUTC().toMillis())
        .filter((ms): ms is number => typeof ms === "number"),
    ),
  ].sort((a, b) => a - b);

  return sortedMs.slice(0, cap).includes(t);
}

/**
 * Minimal series defaults carried from the source event (title + location),
 * mirroring the fields applyTemplateToEventDraft supports, so a later
 * generateEventsFromSeries can stamp sibling drafts.
 *
 * Both fields are clamped into the seriesDefaultsSchema bounds (title 140→120,
 * freeform address 280→200): the schema THROWS on overflow at parse time, so
 * an unclamped value would poison the stored defaults and break every later
 * series read for this owner. A too-long address drops the location default
 * (null) rather than truncating an address; a null titlePrefix simply falls
 * back to the series name at generation time.
 */
function deriveDefaultsFromEvent(event: EventRecord): EventSeriesDefaults {
  const location = deriveEventLocation(event);
  return {
    titlePrefix: clampSeriesDefaultsTitlePrefix(event.title),
    location: fitsSeriesDefaultsLocation(location) ? location : null,
    categories: null,
    types: null,
    attributes: null,
    feePolicyId: null,
    payoutTermsDraft: null,
    agreementDraft: null,
    ticketTypes: null,
  } satisfies EventSeriesDefaults;
}

/**
 * Series-defaults location shape derived from an event (place > saved
 * location > freeform > none/null). Exported for reuse by syncSeriesDrafts,
 * which refreshes `Series.defaults.location` from the edited pivot event.
 */
export function deriveEventLocation(event: EventRecord): TemplateLocation | null {
  if (event.placeId) {
    return { kind: "place", placeId: event.placeId };
  }
  if (event.savedLocationId) {
    return { kind: "saved-location", savedLocationId: event.savedLocationId };
  }
  if (event.addressText && event.lat !== null && event.lng !== null) {
    return {
      kind: "freeform",
      addressText: event.addressText,
      lat: event.lat,
      lng: event.lng,
    };
  }
  return null;
}

function buildNameCandidate(base: string, attempt: number): string {
  if (attempt === 1) {
    return base;
  }
  const suffix = ` (${attempt})`;
  return `${base.slice(0, SERIES_NAME_MAX_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

/** Prisma unique-violation shape without importing Prisma into core. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Pick a series name that does not collide with the DB unique constraint.
 *
 * The base name colliding with an ACTIVE series is a hard SERIES_NAME_TAKEN.
 * Beyond that, the unique constraint (ownerScope, ownerId, nameNormalized)
 * SPANS ARCHIVED rows — a title-derived name can hit an archived twin that
 * findActiveByName never sees. We cannot catch-and-retry the insert inside
 * repos.tx (a failed statement aborts the whole Postgres transaction), so the
 * collision is resolved UP FRONT via series.nameExists, retrying with a
 * numeric suffix ("Name (2)" … "(5)").
 */
async function resolveSeriesName(
  tx: TxRepos,
  ownerScope: EventSeriesOwnerScope,
  ownerId: string,
  base: string,
): Promise<string> {
  const normalizedBase = base.trim().toLowerCase();
  const activeTwin = await tx.series.findActiveByName(
    ownerScope,
    ownerId,
    normalizedBase,
  );
  if (activeTwin) {
    throw fail("SERIES_NAME_TAKEN");
  }

  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = buildNameCandidate(base, attempt);
    const taken = await tx.series.nameExists(
      ownerScope,
      ownerId,
      candidate.trim().toLowerCase(),
    );
    if (!taken) {
      return candidate;
    }
  }

  throw fail("SERIES_NAME_TAKEN");
}

export async function convertEventToSeries(
  deps: ConvertEventToSeriesDeps,
  rawInput: unknown,
): Promise<ConvertEventToSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "convertEventToSeries" });

  const execute = async () => {
    const input = parseInput(convertEventToSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredConvertRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredConvertRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) => {
        const event = await tx.events.getById(input.eventId);
        if (!event) {
          throw fail("EVENT_NOT_FOUND");
        }
        if (event.status === "CANCELLED") {
          throw fail("EVENT_ALREADY_CANCELLED");
        }

        const now = deps.clock.now();

        // Converting a past show into a recurring series is meaningless, and
        // a past occurrence sits outside reconcile's future-only bookkeeping
        // (ordinal scans aside) — reject up front. Same code rsvp-to-event
        // uses for "this event is in the past".
        if (event.startsAt.getTime() <= now.getTime()) {
          throw fail("EVENT_ALREADY_ENDED");
        }

        // Resolve the series owner from the event's owner. COMMUNITY
        // (ownerless) events cannot own a series.
        let ownerScope: EventSeriesOwnerScope;
        let ownerId: string;
        if (event.orgId) {
          ownerScope = "ORGANIZATION";
          ownerId = event.orgId;
        } else if (event.humanId) {
          ownerScope = "HUMAN";
          ownerId = event.humanId;
        } else {
          throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
        }

        await ensureSeriesOwnerAccess(
          tx,
          ownerScope,
          ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        const existingLink = await tx.seriesOccurrences.findSeriesIdByEventId(
          event.id,
        );
        if (existingLink) {
          throw fail("EVENT_ALREADY_IN_SERIES", {
            meta: { seriesId: existingLink.seriesId },
          });
        }

        // Event.timezone is NOT NULL in the schema; the series inherits it so
        // the schedule's ISO strings keep meaning the same wall-clock times.
        const timezone = event.timezone;

        if (!isInstantOnSchedule(input.schedule, timezone, event.startsAt)) {
          throw fail("EVENT_START_NOT_IN_SCHEDULE");
        }

        const baseName = (input.name ?? event.title)
          .trim()
          .slice(0, SERIES_NAME_MAX_LENGTH)
          .trim();
        const name = await resolveSeriesName(
          tx,
          ownerScope,
          ownerId,
          baseName.length > 0 ? baseName : "Untitled series",
        );

        let created;
        try {
          created = await tx.series.create({
            ownerScope,
            ownerId,
            name,
            description: null,
            timezone,
            schedule: normalizeSchedule(input.schedule),
            templateId: null,
            defaults: deriveDefaultsFromEvent(event),
            createdByHumanId: input.actorHumanId,
            createdAt: now,
          });
        } catch (error) {
          // Race backstop only: a concurrent create can still win the
          // (ownerScope, ownerId, nameNormalized) constraint between our
          // nameExists pre-check and this insert. Throwing (never retrying)
          // is required — the failed statement already aborted the tx.
          if (isUniqueViolation(error)) {
            throw fail("SERIES_NAME_TAKEN");
          }
          throw error;
        }

        // Materialize the event as occurrence #1. bulkUpsert accepts the
        // status directly, so no interim PLANNED state ever exists.
        const occurrenceStatus =
          event.status === "PUBLISHED" ? "PUBLISHED" : "GENERATED";
        await tx.seriesOccurrences.bulkUpsert({
          occurrences: [
            {
              seriesId: created.id,
              ordinal: 1,
              startsAt: event.startsAt,
              endsAt: event.endsAt ?? null,
              status: occurrenceStatus,
            },
          ],
        });

        const page = await tx.seriesOccurrences.listBySeries({
          seriesId: created.id,
          limit: 1,
        });
        const occurrence = page.items[0];
        if (!occurrence) {
          throw fail("OCCURRENCE_NOT_FOUND");
        }

        try {
          await tx.seriesOccurrences.attachEvent({
            occurrenceId: occurrence.id,
            eventId: event.id,
            updatedAt: now,
          });
        } catch (error) {
          // A concurrent convert of the SAME event can win the
          // EventSeriesOccurrence.eventId @unique constraint between our
          // findSeriesIdByEventId check and this attach. Surface the truthful
          // conflict (throw, never retry — the failed statement already
          // aborted the tx).
          if (isUniqueViolation(error)) {
            throw fail("EVENT_ALREADY_IN_SERIES");
          }
          throw error;
        }

        await tx.audit.log({
          entity: "event_series",
          entityId: created.id,
          action: "converted_from_event",
          data: {
            eventId: event.id,
            occurrenceId: occurrence.id,
            occurrenceStatus,
            ownerScope,
          },
          at: now,
        });

        deps.metrics?.increment("series.converted", {
          count: "1",
          ownerScope,
        });

        scopedLogger?.info?.("convert_event_to_series_complete", {
          seriesId: created.id,
          eventId: event.id,
          occurrenceId: occurrence.id,
        });

        return convertEventToSeriesResultSchema.parse({
          seriesId: created.id,
          occurrenceId: occurrence.id,
        });
      });

      await deps.idempotency.commit<StoredConvertRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("convert_event_to_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("convertEventToSeries", execute);
  }
  return execute();
}
