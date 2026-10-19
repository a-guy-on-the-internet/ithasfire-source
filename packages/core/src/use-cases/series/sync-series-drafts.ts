import { createHash } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos, SaveEventInput } from "@th/ports/repos";
import type { EventRecord, EventSeriesDefaults } from "@th/types";

import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { onEventLocationChanged } from "../arrival-areas/on-event-location-changed";
import { syncEventArrivalAreasToDraft } from "../arrival-areas/sync-event-arrival-areas";
import { resolveAddressReveal } from "../events/_shared/save-event-shared";
import { deriveEventLocation } from "./convert-event-to-series";
import { ensureLocationAccessible } from "./generate-events-from-series";
import {
  ensureSeriesOwnerAccess,
  type SeriesOwnerContext,
} from "./permissions";
import {
  syncSeriesDraftsInputSchema,
  syncSeriesDraftsResultSchema,
  type SyncSeriesDraftsInput,
  type SyncSeriesDraftsResult,
} from "./schemas";
import {
  clampSeriesDefaultsTitlePrefix,
  fitsSeriesDefaultsLocation,
} from "./utils";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 120;

/**
 * PROPAGATABLE DEFINITION FIELDS — the exact set of source-event fields
 * stamped onto each sibling DRAFT via `events.upsertDraft` (its UPDATE
 * branch). This is the full intersection of "definition, not state" and
 * "fields the upsertDraft primitive can actually persist on update".
 *
 * Included:
 *  - `title`               — event title.
 *  - `content`             — listing body (ProseMirror JSON).
 *  - `defaultLocale`       — content locale.
 *  - `location`            — place / saved-location / freeform address block
 *                            (freeform carries locality/region/country/postal).
 *  - `locationMode`        — EXACT / OBSCURED.
 *  - `locationRadiusMeters`— OBSCURED obfuscation radius.
 *  - `locationLabel`       — redacted-view area label.
 *  - `addressRevealPreset` — reveal timing choice. A legacy OBSCURED source
 *                            (stored reveal date but no preset) is treated as
 *                            an explicit CUSTOM so siblings inherit the
 *                            SOURCE's reveal rather than diverging onto their
 *                            own stored values.
 *  - `addressRevealAt`     — NOT copied raw: recomputed per target from the
 *                            source's preset against the TARGET's own startsAt
 *                            (via resolveAddressReveal), because the reveal
 *                            instant is date-relative. CUSTOM keeps the
 *                            source's absolute instant.
 *  - `instructionalAdmission`         — organizer tax attestation (definition
 *                                       of what the event IS; drives the TN
 *                                       instruction exemption at publish).
 *  - `resalePayoutReleaseDaysOverride`— per-event resale payout policy.
 *
 * Deliberately EXCLUDED:
 *  - `startsAt` / `endsAt` / `timezone` — occurrence-owned scheduling; the
 *    target keeps its own (startsAt/endsAt are re-sent unchanged because the
 *    primitive requires them; timezone is omitted so the adapter leaves it).
 *  - `placeLayoutId` — the SOURCE's layout is NOT propagated: every saveEvent
 *    path that persists a layout also materializes SeatSection/Seat rows, and
 *    sync has no seat-materialization wiring — stamping the link alone would
 *    yield siblings with a layout and zero seat inventory. Deferred rather
 *    than faked (like ageLimit; materialization wiring is its own follow-up).
 *    The TARGET's own layout is preserved when its place is unchanged — the
 *    adapter's update branch resets placeLayoutId to null unless re-sent, so
 *    the payload re-sends the target's own value in that case; when the sync
 *    CHANGES the place, the link is left to clear (layouts are place-scoped).
 *  - `status` / `slug` / `shortId` / `regionCode` / `publishedAt` /
 *    `currency` / tax stamps / payout-terms ids — per-event lifecycle,
 *    publishing, and money state.
 *  - `heroImageId` — EventImage rows are EVENT-scoped; cross-linking a
 *    sibling draft to the source's image record is unsafe. EventRecord doesn't
 *    even expose the id. Siblings keep their own hero (the key is simply
 *    absent from the payload, which the adapter treats as "leave unchanged").
 *  - `ageLimit` — upsertDraft's UPDATE branch does not persist it, so it
 *    cannot be propagated through this primitive today (silent no-op if
 *    passed); deferred rather than faked.
 *  - visibility / gateType / attendanceMode / category / tags — not part of
 *    SaveEventInput; they are managed by their own primitives.
 *  - ticket types — NOT synced in v1 (see use-case docstring).
 */
export const SERIES_DRAFT_SYNC_FIELDS = [
  "title",
  "content",
  "defaultLocale",
  "location",
  "locationMode",
  "locationRadiusMeters",
  "locationLabel",
  "addressRevealPreset",
  "addressRevealAt",
  "instructionalAdmission",
  "resalePayoutReleaseDaysOverride",
] as const;

export type SyncSeriesDraftsDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

type StoredSyncRecord = {
  payloadHash: string;
  response: SyncSeriesDraftsResult;
};

function buildIdempotencyKey(input: SyncSeriesDraftsInput): string {
  return `series:sync-drafts:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: SyncSeriesDraftsInput): string {
  const normalized = {
    seriesId: input.seriesId,
    sourceEventId: input.sourceEventId,
    scope: input.scope,
    includeArrivalAreas: input.includeArrivalAreas,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/**
 * Draft-write location shape derived from the source event (place > saved
 * location > freeform > none). Richer than the series-defaults TemplateLocation because SaveEventInput's
 * freeform carries the locality/region/country/postal block.
 */
function buildDraftLocation(source: EventRecord): SaveEventInput["location"] {
  if (source.placeId) {
    return { kind: "place", placeId: source.placeId };
  }
  if (source.savedLocationId) {
    return {
      kind: "saved-location",
      savedLocationId: source.savedLocationId,
    };
  }
  if (source.lat != null && source.lng != null && source.addressText) {
    return {
      kind: "freeform",
      addressText: source.addressText,
      lat: source.lat,
      lng: source.lng,
      locality: source.locality ?? null,
      region: source.region ?? null,
      countryCode: source.countryCode ?? null,
      postalCode: source.postalCode ?? null,
    };
  }
  return { kind: "none" };
}

/**
 * The exact upsertDraft payload for one target. Keys OUTSIDE
 * {@link SERIES_DRAFT_SYNC_FIELDS} are either the update-branch selector
 * (eventId), owner scoping (never changes ownership on update), the
 * occurrence-owned schedule fields re-sent with the TARGET's own values
 * because the primitive requires them, or the target's own placeLayoutId
 * re-sent to survive the adapter's reset-then-reapply (see the constant's
 * exclusion notes). `timezone` / `heroImageId` / `createdAt` are deliberately
 * ABSENT — the adapter's hasOwnProperty guards then leave the target's
 * values untouched.
 */
function buildSyncedDraftInput(args: {
  source: EventRecord;
  target: EventRecord;
  owner: SeriesOwnerContext;
  location: SaveEventInput["location"];
  now: Date;
}): SaveEventInput {
  const { source, target, owner, location, now } = args;

  // The reveal instant is date-relative (e.g. DAY_BEFORE), so it is
  // recomputed against the TARGET's startsAt rather than copied raw. EXACT
  // nulls both fields; CUSTOM keeps the source's absolute instant (the only
  // information a custom choice carries). A legacy OBSCURED source with a
  // stored reveal date but no preset is pre-derived to CUSTOM here — never
  // left to resolveAddressReveal's existingEvent fallback, which would leak
  // the TARGET's own reveal settings and make siblings diverge from the
  // source. (An OBSCURED source with NEITHER field carries zero reveal
  // information; the resolver then keeps the target's own settings or
  // defaults to DAY_BEFORE.)
  const reveal = resolveAddressReveal({
    locationMode: source.locationMode,
    startsAt: target.startsAt,
    preset:
      source.addressRevealPreset ??
      (source.addressRevealAt ? "CUSTOM" : undefined),
    addressRevealAt: source.addressRevealAt,
    existingEvent: target,
    now,
  });

  // Preserve the TARGET's own seating layout when its place is unchanged:
  // the adapter's update branch resets placeLayoutId to null unless the key
  // is re-sent inside the place branch, and silently clearing a sibling's
  // seating link (with its materialized seats) would be destructive. When
  // the sync changes the place, the old layout is invalid (place-scoped) and
  // is left to clear. The SOURCE's layout is never propagated (no seat
  // materialization here — see the constant's exclusion notes).
  const preservedLayout =
    location.kind === "place" &&
    target.placeLayoutId &&
    target.placeId === location.placeId
      ? { placeLayoutId: target.placeLayoutId }
      : {};

  return {
    eventId: target.id,
    orgId: owner.kind === "org" ? owner.orgId : null,
    humanId: owner.kind === "human" ? owner.humanId : null,
    // Occurrence-owned scheduling: ALWAYS the target's own values.
    startsAt: target.startsAt,
    endsAt: target.endsAt ?? null,
    status: "DRAFT",
    // Propagated definition fields (SERIES_DRAFT_SYNC_FIELDS).
    title: source.title,
    content: source.content ?? null,
    defaultLocale: source.defaultLocale ?? null,
    location,
    ...preservedLayout,
    locationMode: source.locationMode,
    locationRadiusMeters: source.locationRadiusMeters,
    locationLabel: source.locationLabel,
    addressRevealPreset: reveal.preset,
    addressRevealAt: reveal.at,
    instructionalAdmission: source.instructionalAdmission ?? false,
    resalePayoutReleaseDaysOverride:
      source.resalePayoutReleaseDaysOverride ?? null,
  };
}

/**
 * Propagate the edited pivot event's DEFINITION onto its sibling DRAFT shows
 * ("This and following" / "All shows" in the builder dialog).
 *
 * Semantics (v1 — deliberately simple):
 *  - The source event must be attached to one of THIS series' ACTIVE
 *    (GENERATED/PUBLISHED) occurrences. DETACHED/CANCELLED occurrences keep
 *    their stale eventId (bulkDetach never clears it), so an orphaned
 *    event's definition is never accepted as a sync source.
 *  - Targets are the series' GENERATED occurrences with a linked DRAFT
 *    event, excluding the source's own occurrence. Past/future
 *    classification for TARGETS uses the linked EVENT's startsAt — the date
 *    the show will actually run under, even when it was edited directly in
 *    the builder and the occurrence hasn't been reconciled yet. Strictly
 *    `startsAt > now` counts as future. PUBLISHED occurrences are classified
 *    by their occurrence startsAt (their events are never loaded).
 *  - Scope "future" keeps only future targets (past GENERATED ones are
 *    counted into `skippedPastCount`); scope "all" includes past GENERATED
 *    occurrences as targets.
 *  - PUBLISHED occurrences are NEVER touched. They are counted into
 *    `skippedPublishedCount` — future-only under scope "future" (past
 *    published dates are not counted at all there), every published one under
 *    scope "all" — so the UI can say "N published dates unchanged".
 *  - A target whose linked event is no longer a DRAFT at write time
 *    (published out-of-band between list and write, archived, cancelled — or
 *    the row is gone entirely) is skipped and counted into
 *    `skippedPublishedCount` too: one "left alone because it moved past
 *    draft" bucket keeps the result contract simple. This check runs BEFORE
 *    past/future classification (the event row is needed for the date), so a
 *    past non-draft counts as skippedPublished, not skippedPast.
 *  - OVERWRITE semantics: target drafts are overwritten regardless of manual
 *    edits. There is no customized-field tracking in v1 — the dialog copy
 *    owns that honesty.
 *  - Arrival areas (arrival-areas FR-015) are OPTIONAL (owner Q13,
 *    2026-10-17: "Also replace parking and drop-off areas on these shows",
 *    off by default). With `includeArrivalAreas` each target draft's
 *    event-only areas and hides are made the source's
 *    (`syncEventArrivalAreasToDraft`), audited per area; without it they are
 *    left exactly as they are. Either way, a target the sync MOVES to
 *    another place or address has its own areas switched off and its stale
 *    hides dropped (FR-014, `onEventLocationChanged`): that is a safety
 *    rule, not a copy.
 *  - Ticket types are NOT synced in v1. They were copied at generation time
 *    (generateEventsFromSeries); re-syncing them against live edits risks
 *    money surprises (repricing types buyers may be mid-checkout on for a
 *    sibling, resurrecting deleted tiers, capacity clobbering), so pricing
 *    changes propagate only to drafts generated AFTER the edit via the
 *    two-tier copy source.
 *  - `Series.defaults` (titlePrefix + location — the shape
 *    convertEventToSeries writes) is refreshed from the source event so
 *    FUTURE generations also reflect the change. Candidates are clamped into
 *    the seriesDefaultsSchema bounds first (title 140→120, freeform address
 *    280→200 — the schema THROWS on overflow, and a poisoned defaults JSON
 *    breaks every later series read for the owner); an unusable candidate
 *    KEEPS the prior key rather than aborting the sync. Other defaults keys
 *    are preserved untouched.
 *  - Atomic: everything runs in one repos.tx; any write failure rolls the
 *    whole batch back (mirrors generateEventsFromSeries — there are no
 *    external side effects here).
 */
export async function syncSeriesDrafts(
  deps: SyncSeriesDraftsDeps,
  rawInput: unknown,
): Promise<SyncSeriesDraftsResult> {
  const scopedLogger = deps.logger?.child({ useCase: "syncSeriesDrafts" });

  const execute = async () => {
    const input = parseInput(syncSeriesDraftsInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    const replay = await deps.idempotency.get<StoredSyncRecord>(idempotencyKey);
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
        await deps.idempotency.get<StoredSyncRecord>(idempotencyKey);
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

        const occurrences = await tx.seriesOccurrences.listBySeriesAndStatuses(
          series.id,
          ["GENERATED", "PUBLISHED"],
          new Date(0),
        );

        // The pivot must be attached to one of THIS series' ACTIVE
        // occurrences. Checking membership in the GENERATED/PUBLISHED
        // listing (rather than findSeriesIdByEventId, which has no status
        // filter) rejects three cases with one guard: an event from another
        // series, an unattached event, and — critically — an event whose
        // occurrence was DETACHED/CANCELLED (bulkDetach keeps the stale
        // eventId, and a stale definition must never propagate to siblings).
        const sourceAttached = occurrences.some(
          (occurrence) => occurrence.eventId === input.sourceEventId,
        );
        if (!sourceAttached) {
          throw fail("OCCURRENCE_NOT_FOUND");
        }

        const source = await tx.events.getById(input.sourceEventId);
        if (!source) {
          throw fail("EVENT_NOT_FOUND");
        }

        const now = deps.clock.now();

        // The location is identical for every target — validate access ONCE
        // up front (throws → atomic batch failure, mirroring generate).
        const location = buildDraftLocation(source);
        await ensureLocationAccessible(tx, owner, location);

        let updatedDraftCount = 0;
        let skippedPublishedCount = 0;
        let skippedPastCount = 0;

        for (const occurrence of occurrences) {
          // The pivot's own occurrence is never a target and never counted.
          if (occurrence.eventId === input.sourceEventId) {
            continue;
          }

          if (occurrence.status === "PUBLISHED") {
            // Never touched. Scope "future" reports only future published
            // dates ("N published dates unchanged" is about dates the sync
            // WOULD have covered); scope "all" reports every published one.
            // Published events are never loaded, so this classification uses
            // the occurrence's startsAt.
            const isFuture = occurrence.startsAt.getTime() > now.getTime();
            if (input.scope === "all" || isFuture) {
              skippedPublishedCount += 1;
            }
            continue;
          }

          // GENERATED from here. A GENERATED occurrence without an eventId
          // is an invariant breach (attach + markStatus are transactional) —
          // defensively ignore rather than crash the batch.
          if (!occurrence.eventId) {
            continue;
          }

          const target = await tx.events.getById(occurrence.eventId);
          if (!target || target.status !== "DRAFT") {
            // Published/archived/cancelled out-of-band between list and
            // write (or the row is gone) — leave it alone. Folded into the
            // published counter: one "not a draft anymore" bucket.
            skippedPublishedCount += 1;
            continue;
          }

          // Past/future for targets follows the EVENT's actual date, which
          // may have been edited directly in the builder without a schedule
          // reconcile — scope should reflect when the show will really run.
          const isFuture = target.startsAt.getTime() > now.getTime();
          if (input.scope === "future" && !isFuture) {
            skippedPastCount += 1;
            continue;
          }

          // upsertDraft with a TRUTHY eventId is the adapter's plain-UPDATE
          // branch — exactly right here (P2025 if the row vanished, which
          // rolls the whole tx back).
          const written = await tx.events.upsertDraft(
            buildSyncedDraftInput({ source, target, owner, location, now }),
          );
          // arrival-areas FR-014: a sync that moves this draft to another
          // place or address switches its own areas off and drops stale
          // hides, in this transaction, audited.
          await onEventLocationChanged(tx, {
            before: target,
            after: written,
            actorHumanId: input.actorHumanId,
            now,
          });
          // arrival-areas FR-015, only when the organiser ticked "Also
          // replace parking and drop-off areas" (owner Q13): the draft's own
          // areas and hides follow the source's, like its location (after
          // the hook above, which switched the old ones off for the move).
          if (input.includeArrivalAreas) {
            await syncEventArrivalAreasToDraft(tx, {
              source,
              target: written,
              actorHumanId: input.actorHumanId,
              now,
            });
          }
          updatedDraftCount += 1;
        }

        // Refresh Series.defaults (title + location — the convert shape) so
        // FUTURE generations inherit the edit too. Candidates are clamped
        // into the seriesDefaultsSchema bounds; an unusable candidate keeps
        // the PRIOR key (never aborts the sync). Other keys survive as-is.
        const priorDefaults = series.defaults ?? {};
        const candidateLocation = deriveEventLocation(source);
        const nextDefaults: EventSeriesDefaults = {
          categories: null,
          types: null,
          attributes: null,
          feePolicyId: null,
          payoutTermsDraft: null,
          agreementDraft: null,
          ticketTypes: null,
          ...priorDefaults,
          titlePrefix:
            clampSeriesDefaultsTitlePrefix(source.title) ??
            priorDefaults.titlePrefix ??
            null,
          location: fitsSeriesDefaultsLocation(candidateLocation)
            ? candidateLocation
            : (priorDefaults.location ?? null),
        };
        await tx.series.update(series.id, {
          defaults: nextDefaults,
          updatedByHumanId: input.actorHumanId,
          updatedAt: now,
        });

        await tx.audit.log({
          entity: "event_series",
          entityId: series.id,
          action: "drafts_synced",
          data: {
            sourceEventId: source.id,
            scope: input.scope,
            includeArrivalAreas: input.includeArrivalAreas,
            updatedDraftCount,
            skippedPublishedCount,
            skippedPastCount,
          },
          at: now,
        });

        deps.metrics?.increment("series.drafts_synced", {
          count: updatedDraftCount.toString(),
          scope: input.scope,
          ownerScope: series.ownerScope,
        });

        scopedLogger?.info?.("sync_series_drafts_complete", {
          seriesId: series.id,
          sourceEventId: source.id,
          scope: input.scope,
          updatedDraftCount,
          skippedPublishedCount,
          skippedPastCount,
        });

        return syncSeriesDraftsResultSchema.parse({
          updatedDraftCount,
          skippedPublishedCount,
          skippedPastCount,
        });
      });

      await deps.idempotency.commit<StoredSyncRecord>(idempotencyKey, {
        payloadHash,
        response: result,
      });

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("sync_series_drafts", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("syncSeriesDrafts", execute);
  }
  return execute();
}
