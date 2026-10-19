import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, SaveEventInput, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type {
  EventSeriesOccurrenceRecord,
  EventSeriesOccurrenceStatus,
  EventSeriesRecord,
  EventTemplateRecord,
  EventTicketTypeSummary,
  TemplateLocation,
} from "@th/types";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { eventAreaPin } from "../arrival-areas/_shared/event-area-access";
import {
  copyEventArrivalAreasToNewDraft,
  readGenerationAreaSource,
} from "../arrival-areas/sync-event-arrival-areas";
import { assignSlugOnCreate } from "../events/_shared/assign-slug-on-create";
import { ensureSeriesOwnerAccess, type SeriesOwnerContext } from "./permissions";
import {
  generateEventsFromSeriesInputSchema,
  generateEventsFromSeriesResultSchema,
  type GenerateEventsFromSeriesInput,
  type GenerateEventsFromSeriesResult,
} from "./schemas";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

export type GenerateEventsFromSeriesDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * Best-effort reporter for the deliberate swallow inside `assignSlugOnCreate`
   * — a generated draft that cannot be slugged is still generated, so without
   * this the failure would be invisible (repo Sentry convention, CLAUDE.md).
   */
  reportError?: ReporterPort;
};

type StoredGenerateRecord = {
  payloadHash: string;
  response: GenerateEventsFromSeriesResult;
};

function buildIdempotencyKey(input: GenerateEventsFromSeriesInput): string {
  return `series:generate:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: GenerateEventsFromSeriesInput): string {
  const normalized = {
    seriesId: input.seriesId,
    occurrenceIds: input.occurrenceIds
      ? [...input.occurrenceIds].sort()
      : null,
    limit: input.limit ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Merge order per the series spec: Template.defaults → Series.defaults →
 * Occurrence.overrides (later layers win). Only the fields the draft
 * primitive supports are applied — title + location, mirroring
 * applyTemplateToEventDraft.
 *
 * `Series.defaults.titlePrefix` is the series-level title layer: convert-
 * event-to-series stores the source event's title there so generated sibling
 * drafts inherit it.
 */
function mergeDraftFields(
  series: EventSeriesRecord,
  template: EventTemplateRecord | null,
  occurrence: EventSeriesOccurrenceRecord,
): { title: string; location: SaveEventInput["location"] } {
  const title =
    occurrence.overrides?.title ??
    series.defaults?.titlePrefix ??
    template?.defaults?.title ??
    series.name;

  const location =
    occurrence.overrides?.location ??
    series.defaults?.location ??
    template?.defaults?.location ??
    null;

  return { title, location: normalizeLocation(location) };
}

function normalizeLocation(
  location: TemplateLocation | null | undefined,
): SaveEventInput["location"] {
  if (!location) {
    return { kind: "none" };
  }
  switch (location.kind) {
    case "place":
      return { kind: "place", placeId: location.placeId };
    case "saved-location":
      return {
        kind: "saved-location",
        savedLocationId: location.savedLocationId,
      };
    case "freeform":
      return {
        kind: "freeform",
        addressText: location.addressText,
        lat: location.lat,
        lng: location.lng,
      };
    case "none":
    default:
      return { kind: "none" };
  }
}

/**
 * Access check for referenced locations, mirroring
 * applyTemplateToEventDraft's ensureLocationAccessible: the series owner must
 * still be able to use the place / saved location before it is stamped onto a
 * draft. Throws (atomic batch failure) rather than degrading.
 *
 * Exported for reuse by syncSeriesDrafts (same "stamp a location onto sibling
 * drafts" concern). Returns the place it read for a `place` location (null
 * for every other kind) so a caller needing the row does not read it again.
 */
export async function ensureLocationAccessible(
  tx: TxRepos,
  owner: SeriesOwnerContext,
  location: SaveEventInput["location"],
): Promise<PlaceRecord | null> {
  if (location.kind === "place") {
    const place = await tx.places.getById(location.placeId);
    const hasAccess =
      owner.kind === "org"
        ? place?.orgIdsWithAccess.includes(owner.orgId)
        : place?.humanIdsWithAccess.includes(owner.humanId);
    if (!place || !hasAccess) {
      throw fail("PLACE_NOT_FOUND");
    }
    if (place.status !== "ACTIVE") {
      throw fail("PLACE_NOT_ACTIVE");
    }
    return place;
  }

  if (location.kind === "saved-location") {
    const saved =
      owner.kind === "org"
        ? await tx.savedLocations.getAccessibleByOrg({
            id: location.savedLocationId,
            orgId: owner.orgId,
          })
        : await tx.savedLocations.getAccessibleByHuman({
            id: location.savedLocationId,
            humanId: owner.humanId,
          });
    if (!saved) {
      throw fail("SAVED_LOCATION_NOT_FOUND");
    }
  }
  // freeform / none: nothing to validate
  return null;
}

export async function generateEventsFromSeries(
  deps: GenerateEventsFromSeriesDeps,
  rawInput: unknown,
): Promise<GenerateEventsFromSeriesResult> {
  const scopedLogger = deps.logger?.child({
    useCase: "generateEventsFromSeries",
  });

  const execute = async () => {
    const input = parseInput(generateEventsFromSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay =
      await deps.idempotency.get<StoredGenerateRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredGenerateRecord>(idempotencyKey);
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
        const series = await tx.series.getById(input.seriesId);
        if (!series) {
          throw fail("SERIES_NOT_FOUND");
        }
        if (!series.active || series.archivedAt) {
          throw fail("SERIES_INACTIVE");
        }

        const owner = await ensureSeriesOwnerAccess(
          tx,
          series.ownerScope,
          series.ownerId,
          input.actorHumanId,
          { purpose: "edit" },
          scopedLogger,
        );

        // Template layer of the defaults merge. A template that has been
        // archived/deactivated (or reassigned) since the series was created is
        // treated as ABSENT rather than failing generation — the series' own
        // defaults still apply. This is conditional data-state logic, not a
        // swallowed failure (no catch), so no reportError is involved.
        let template: EventTemplateRecord | null = null;
        if (series.templateId) {
          const candidate = await tx.eventTemplates.getById(series.templateId);
          if (
            candidate &&
            candidate.active &&
            !candidate.archivedAt &&
            candidate.ownerScope === series.ownerScope &&
            candidate.ownerId === series.ownerId
          ) {
            template = candidate;
          }
        }

        const now = deps.clock.now();

        // Ticket-type copy source: the earliest-ordinal occurrence with a
        // linked event AT CALL TIME (resolved before any drafts are created,
        // so freshly generated drafts can never become their own source).
        // ACTIVE occurrences (GENERATED/PUBLISHED) are preferred — bulkDetach
        // doesn't clear eventId, so a DETACHED/CANCELLED occurrence keeps its
        // stale event link and must never shadow a live sibling as the copy
        // source. Only when NO active occurrence has an event do we fall back
        // to any-status (e.g. a series whose only materialized date was
        // detached — better a stale definition than none). No source event →
        // drafts are created without ticket types, silently (the result
        // already reports generated/skipped).
        const allStatuses: EventSeriesOccurrenceStatus[] = [
          "PLANNED",
          "SKIPPED",
          "GENERATED",
          "PUBLISHED",
          "CANCELLED",
          "DETACHED",
        ];
        const allOccurrences =
          await tx.seriesOccurrences.listBySeriesAndStatuses(
            series.id,
            allStatuses,
            new Date(0),
          );
        let activeSourceEventId: string | null = null;
        let activeSourceOrdinal = Number.POSITIVE_INFINITY;
        let fallbackSourceEventId: string | null = null;
        let fallbackSourceOrdinal = Number.POSITIVE_INFINITY;
        for (const occ of allOccurrences) {
          if (!occ.eventId) continue;
          if (occ.status === "GENERATED" || occ.status === "PUBLISHED") {
            if (occ.ordinal < activeSourceOrdinal) {
              activeSourceOrdinal = occ.ordinal;
              activeSourceEventId = occ.eventId;
            }
          } else if (occ.ordinal < fallbackSourceOrdinal) {
            fallbackSourceOrdinal = occ.ordinal;
            fallbackSourceEventId = occ.eventId;
          }
        }
        const sourceEventId = activeSourceEventId ?? fallbackSourceEventId;
        const sourceTicketTypes: EventTicketTypeSummary[] = sourceEventId
          ? await tx.events.listTicketTypes(sourceEventId)
          : [];
        // arrival-areas, owner Q12 (2026-10-17): the SAME source gives each
        // new draft its event-only areas and hides. One copy source per run
        // keeps a draft's tiers and its parking from two different shows,
        // and it is resolved before any draft exists (a fresh draft never
        // copies from itself). Null when the source has nothing to copy.
        const areaSource = sourceEventId
          ? await readGenerationAreaSource(tx, sourceEventId)
          : null;

        // Resolve target occurrences: explicit ids win; otherwise the first
        // `limit` FUTURE PLANNED occurrences by startsAt asc.
        let targets: EventSeriesOccurrenceRecord[];
        if (input.occurrenceIds && input.occurrenceIds.length > 0) {
          const uniqueIds = [...new Set(input.occurrenceIds)];
          targets = [];
          for (const occurrenceId of uniqueIds) {
            const occurrence =
              await tx.seriesOccurrences.getById(occurrenceId);
            if (!occurrence || occurrence.seriesId !== series.id) {
              throw fail("OCCURRENCE_NOT_FOUND");
            }
            targets.push(occurrence);
          }
          if (input.limit) {
            targets = targets.slice(0, input.limit);
          }
        } else {
          const planned = await tx.seriesOccurrences.listBySeriesAndStatuses(
            series.id,
            ["PLANNED"],
            now,
          );
          targets = planned.slice(0, input.limit ?? planned.length);
        }

        // Validate per occurrence, then write. Ineligible occurrences are
        // reported in `skipped` (spec semantics — not an error); any WRITE
        // failure throws and rolls the whole tx back atomically. There are no
        // external side effects here, so atomic failure is preferred over
        // cancel-event-series' per-target tolerance (which exists only
        // because refunds are non-transactional external calls).
        const generated: {
          occurrenceId: string;
          eventId: string;
          scheduledPricesDropped: number;
          salesWindowsDropped: number;
        }[] = [];
        const skipped: string[] = [];

        for (const occurrence of targets) {
          const eligible =
            occurrence.status === "PLANNED" &&
            !occurrence.eventId &&
            occurrence.startsAt.getTime() > now.getTime();
          if (!eligible) {
            skipped.push(occurrence.id);
            continue;
          }

          const { title, location } = mergeDraftFields(
            series,
            template,
            occurrence,
          );
          const locationPlace = await ensureLocationAccessible(
            tx,
            owner,
            location,
          );
          // Owner Q12 + review round 1: areas and hides are copied only when
          // the draft is at the SAME place as the source. A draft the series
          // defaults put at another place, or any freeform / saved location
          // (no place id on either side), copies nothing: shapes drawn
          // around one address must never outline another, or reveal a
          // withheld place once the draft is published.
          const copyAreasFrom =
            areaSource &&
            location.kind === "place" &&
            areaSource.event.placeId !== null &&
            location.placeId === areaSource.event.placeId
              ? areaSource
              : null;

          // eventId MUST be null here: the Prisma adapter's upsertDraft
          // routes a truthy eventId to a plain UPDATE (P2025 for a fresh id);
          // only a null eventId takes the create branch and returns the new
          // row (same contract save-event-shared relies on).
          const draft = await tx.events.upsertDraft({
            eventId: null,
            orgId: owner.kind === "org" ? owner.orgId : null,
            humanId: owner.kind === "human" ? owner.humanId : null,
            title,
            startsAt: occurrence.startsAt,
            endsAt: occurrence.endsAt ?? null,
            status: "DRAFT",
            timezone: series.timezone,
            location,
          });

          await tx.seriesOccurrences.attachEvent({
            occurrenceId: occurrence.id,
            eventId: draft.id,
            updatedAt: now,
          });
          await tx.seriesOccurrences.markStatus({
            occurrenceId: occurrence.id,
            status: "GENERATED",
            updatedAt: now,
          });

          // Copy the source event's ticket-type DEFINITIONS onto the new
          // draft. Definition fields only — never
          // sold counts, reservations, Stripe ids, or other per-event state
          // (none of which live on TicketType rows; tickets/orders reference
          // the type, not the reverse). seatSectionId is deliberately NOT
          // copied: SeatSection rows are event-scoped, so the source's
          // section id must not be cross-linked onto a different event.
          //
          // scheduledPriceCents / scheduledPriceAt are copied as a pair
          // (FR-004) — UNLESS the instant has already elapsed at generate
          // time, in which case BOTH are nulled (Q-005, RESOLVED 2026-08-11).
          // `scheduledPriceAt` is the one absolute-dated thing in this copy,
          // and a weekly series with "early bird until Jan 1" would otherwise
          // give every occurrence generated in February a schedule that fires
          // the moment it publishes — full price from birth, twelve dates
          // deep, and no organizer audits twelve schedules. Nulling keeps the
          // base `priceCents`, which is what the source charges today, and the
          // drop is counted onto each `generated[]` entry and the audit row
          // rather than swallowed. FR-011's relative { anchor, offsetMinutes }
          // encoding is the real fix; this is the interim guard.
          //
          // ── WHAT THESE GUARDS DO NOT CATCH ────────────────────────────────
          // Both compare against GENERATE TIME, never against the target
          // occurrence's own date. Worked example: on 2026-08-11 an organizer
          // generates the Oct/Nov/Dec occurrences of a series whose advance
          // tier closes 2026-09-01. That close is in the FUTURE, so nothing
          // drops and BOTH counters report 0 — yet October's advance tier stops
          // selling five weeks before its own show and December's is stale on
          // arrival. The organizer is told nothing precisely BECAUSE the
          // counters are the signal and 0 reads as all-clear. Treat
          // `scheduledPricesDropped: 0` / `salesWindowsDropped: 0` as "nothing
          // had already elapsed", never as "these dates make sense".
          //
          // The stricter rule is a TRAP, recorded so nobody "fixes" this by
          // reaching for it: dropping a window that closes before the target
          // occurrence starts would null EVERY advance tier, because closing
          // before the show is exactly what an advance tier is. FR-015's own
          // worked example is `salesClose { EVENT_START, -20160 }` — 14 days
          // before start. It would convert silent staleness into guaranteed
          // data loss on every generation. Telling stale from correct needs the
          // intended OFFSET from the event, which is exactly what FR-011's
          // relative encoding stores and what the schema stores nowhere today.
          // Status DRAFT keeps them non-purchasable:
          // checkout requires event.status === "PUBLISHED"
          // (ensureEventOnSale) and publish-event flips DRAFT types ACTIVE
          // via tickets.activateDraftTicketTypes. A copy failure throws and
          // rolls back the whole generate tx (atomic-failure semantics).
          //
          // salesOpenAt / salesCloseAt (FR-014) get the SAME treatment for the
          // same reason — they are absolute instants too, and a weekly series
          // whose advance tier "closes 14 days before the January show" would
          // otherwise give every February occurrence a tier that is closed the
          // day it is created. When the window has ALREADY CLOSED at generate
          // time, BOTH bounds are nulled and the drop is counted; a still-open
          // or future window is copied untouched. An elapsed `salesOpenAt`
          // alone is NOT a drop — it means "already open", which is what no
          // lower bound means anyway.
          let scheduledPricesDropped = 0;
          let salesWindowsDropped = 0;
          for (const ticketType of sourceTicketTypes) {
            const scheduleElapsed =
              ticketType.scheduledPriceAt != null &&
              ticketType.scheduledPriceAt.getTime() <= now.getTime();
            if (scheduleElapsed) scheduledPricesDropped++;

            const salesWindowElapsed =
              ticketType.salesCloseAt != null &&
              ticketType.salesCloseAt.getTime() <= now.getTime();
            if (salesWindowElapsed) salesWindowsDropped++;

            await tx.tickets.createTicketType({
              eventId: draft.id,
              name: ticketType.name,
              description: ticketType.description,
              priceCents: ticketType.priceCents,
              pricingMode: ticketType.pricingMode,
              minimumCents: ticketType.minimumCents,
              suggestedCents: ticketType.suggestedCents,
              capacity: ticketType.capacity,
              status: "DRAFT",
              createdAt: now,
              seatSectionId: null,
              resaleAllowed: ticketType.resaleAllowed,
              resaleCapCents: ticketType.resaleCapCents,
              transferAllowed: ticketType.transferAllowed,
              scheduledPriceCents: scheduleElapsed
                ? null
                : ticketType.scheduledPriceCents,
              scheduledPriceAt: scheduleElapsed
                ? null
                : ticketType.scheduledPriceAt,
              // Nulled as a PAIR, per FR-016's "null window".
              salesOpenAt: salesWindowElapsed ? null : ticketType.salesOpenAt,
              salesCloseAt: salesWindowElapsed ? null : ticketType.salesCloseAt,
            });
          }

          // Owner Q12: a draft at the source's place starts with the
          // source's event-only areas and hides, audited per area. A copy
          // not within 3 km of the draft's true pin is still copied switched
          // off (FR-014; belt-and-braces, as one place has one pin). The
          // system writes the true pin here: no viewer is involved, and the
          // shapes are copied, not shown. The place row is the one
          // ensureLocationAccessible already read.
          if (copyAreasFrom) {
            await copyEventArrivalAreasToNewDraft(tx, {
              source: copyAreasFrom,
              target: draft,
              targetPin: eventAreaPin(draft, locationPlace, true),
              actorHumanId: input.actorHumanId,
              now,
            });
          }

          generated.push({
            occurrenceId: occurrence.id,
            eventId: draft.id,
            scheduledPricesDropped,
            salesWindowsDropped,
          });
        }

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "events_generated",
          data: {
            generatedCount: generated.length,
            skippedCount: skipped.length,
            occurrenceIds: generated.map((entry) => entry.occurrenceId),
            // Q-005: total elapsed schedules nulled across every draft in this
            // run. Recorded even when 0, so "no drops" is evidence.
            scheduledPricesDropped: generated.reduce(
              (sum, entry) => sum + entry.scheduledPricesDropped,
              0,
            ),
            // FR-014: total already-closed sales windows nulled across every
            // draft in this run. Recorded even when 0, so "no drops" is
            // evidence rather than silence.
            salesWindowsDropped: generated.reduce(
              (sum, entry) => sum + entry.salesWindowsDropped,
              0,
            ),
          },
          at: now,
        });

        deps.metrics?.increment("series.events_generated", {
          count: generated.length.toString(),
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("generate_events_from_series_complete", {
          seriesId: series.id,
          generatedCount: generated.length,
          skippedCount: skipped.length,
          scheduledPricesDropped: generated.reduce(
            (sum, entry) => sum + entry.scheduledPricesDropped,
            0,
          ),
          salesWindowsDropped: generated.reduce(
            (sum, entry) => sum + entry.salesWindowsDropped,
            0,
          ),
        });

        return generateEventsFromSeriesResultSchema.parse({
          generated,
          skipped,
        });
      });

      await deps.idempotency.commit<StoredGenerateRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      // ── Slug the generated drafts (best-effort, POST-COMMIT) ─────────────
      // This path calls `upsertDraft` directly rather than going through
      // `finalizeSaveEvent`, so it needs its own call — without it every
      // series-generated draft would be slugless and its public preview would
      // 500.
      //
      // Deliberately OUTSIDE the generate transaction. A statement that fails
      // at the database aborts the enclosing Postgres transaction, and the
      // COMMIT that follows is answered with ROLLBACK and no error — which
      // Prisma does not surface. Swallowing a slug failure inside the tx would
      // therefore have discarded every draft, every occurrence status change
      // and the audit row in this run while reporting them as generated, and
      // cached that lie under the idempotency key. Each slug now takes its own
      // transaction (see `assignSlugOnCreate`), so one bad draft cannot touch
      // the others or the run that produced them.
      //
      // A crash here leaves slugless drafts — the state
      // `apps/api/src/scripts/backfill/backfill-event-slugs.ts` exists to repair, and a
      // far better outcome than losing the generation itself.
      for (const entry of result.generated) {
        await assignSlugOnCreate(
          { logger: scopedLogger, reportError: deps.reportError },
          deps.repos,
          {
            eventId: entry.eventId,
            now: deps.clock.now(),
            useCase: "generateEventsFromSeries",
          },
        );
      }

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("generate_events_from_series", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("generateEventsFromSeries", execute);
  }
  return execute();
}
