import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import type { PlaceMergeRow } from "@th/ports/repos/place-merge";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { fail, isAppError } from "@th/errors";

import { parseInput } from "../../lib/io";
import {
  moveArrivalAreasForPlaceMerge,
  onEventsMovedByPlaceMerge,
} from "../arrival-areas/place-merge-arrival-areas";
import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  projectPlaceLocationForEvents,
} from "../../lib/location/place-event-location";
import { getEntityPageImageKeyPrefix } from "../entity-pages/page-image-upload-helpers";
import { pageImageKeysMentionedIn } from "../entity-pages/page-image-urls";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { lockLines, sortLineKeys } from "../booking-holds/_shared/hold-line";
import {
  ADDRESS_GROUP_FIELDS,
  deactivatesMergedWaivers,
  PAYOUT_DEFAULT_FIELDS,
  placeMergeInputSchema,
  placeMergeWarningSchema,
  planOwnershipDrops,
  planOwnershipRepoints,
  readPlaceMergePlan,
  type PlaceMergeFillField,
} from "./_shared/place-merge-plan";
import {
  assertDistinctPlaces,
  placeMergeMoveCountsSchema,
  requirePlaceMergeAdmin,
} from "./preview-place-merge";

// ─────────────────────────────────────────────────────────────────────────────
// mergePlaces (merge-duplicate-places spec, FR-001..FR-007).
//
// One transaction:
//   1. lock — the hold-line advisory locks FIRST (`booking_hold_line:<cal>|
//      <date>`, the key `placeHoldOnLine` takes before it reads a line) for
//      every day the merged default calendar holds, on both default
//      calendars, in `sortLineKeys` order: hold-line before everything is the
//      global order (save-event-shared.ts, LOCK ORDER note 4), and the accept
//      mint holds line locks when it takes place_location; then the
//      event-location advisory lock on both places (exclusive, taken before
//      any Place write, same order as `upsertPlace`); then (adapter
//      `lockForMerge`) the Place, Calendar, Space rows, the live/confirmed
//      BookingHold rows on the locked lines only, PlaceWaiver and EntityPage
//      rows FOR UPDATE, each set in id order, and the booking-standards
//      advisory locks for both places and both default calendars in sorted
//      key order.
//      OUT OF SCOPE, known inversion: saving an existing PUBLISHED event
//      takes place_location and THEN the FR-018 settle's `lockLines`
//      (save-event-shared.ts, marked LATENT there). Against this merge it
//      can deadlock; Postgres picks a victim and the merge side surfaces as
//      PLACE_MERGE_RETRY. Fixing it belongs to that save, not here;
//   2. re-read both sides and recompute the blockers UNDER the lock (the
//      preview is advisory; this is the check that counts). A held day that
//      appeared between the line-key read and the row locks retries
//      (PLACE_MERGE_RETRY): its line was not locked;
//   3. fill the survivor's empty fields (D2), re-point every reference
//      (FR-003), move the booking and operations rows (FR-003b: fold the
//      merged default calendar / Main Space into the survivor's, move the
//      other calendars and spaces whole, rewrite series / template location
//      JSON), move the page's followers / notices / slug history (FR-004);
//   3d. move the merged place's arrival areas to the survivor, ids kept
//      (arrival-areas FR-012), whatever the feature gate says: the delete in
//      5 would CASCADE them away;
//   4. re-project the survivor's event locations when events moved or the
//      address filled (events carry a copy of their place's location, and a
//      withheld place's circle is keyed to the place id); then, for the
//      moved events, switch off event-only arrival areas outside 3 km of the
//      survivor's pin and clean hides against the survivor (FR-014);
//   5. stats stale / derived rows gone (FR-005), audit (FR-007), search marks,
//      delete the merged row.
// Any refusal or error rolls all of it back.
// ─────────────────────────────────────────────────────────────────────────────

export const mergePlacesInputSchema = placeMergeInputSchema;
export type MergePlacesInput = z.infer<typeof mergePlacesInputSchema>;

export const mergePlacesOutputSchema = z
  .object({
    survivorId: z.string(),
    mergedId: z.string(),
    pageAction: z.enum(["MOVE_TO_SURVIVOR_PAGE", "TRANSFER_PAGE", "NONE"]),
    filledFields: z.array(z.string()),
    moved: placeMergeMoveCountsSchema,
    /** The preview's warnings, re-read under the lock (FR-002). */
    warnings: z.array(placeMergeWarningSchema),
    /** Events whose stored location was re-projected from the survivor. */
    eventsReprojected: z.number().int().min(0),
    /**
     * arrival-areas FR-014: event-only areas on the moved events switched off
     * (outside 3 km of the survivor's pin). The preview's
     * EVENT_ARRIVAL_AREAS_SWITCH_OFF warning counts the same rule.
     */
    eventArrivalAreasSwitchedOff: z.number().int().min(0),
  })
  .strict();

export type MergePlacesOutput = z.infer<typeof mergePlacesOutputSchema>;

export type MergePlacesDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Post-commit reindex of both places (best-effort; marks are the backstop). */
  search?: MultiSearchPort;
  /** Forwarded to `reindexAfterMutation`, whose swallow reports through it. */
  reportError?: ReporterPort;
};

/** The marker the refusal carries (`meta.reason`); the UI keys off it. */
export const PLACE_MERGE_BLOCKED = "PLACE_MERGE_BLOCKED";

/**
 * The marker a deadlock carries (`meta.reason`): the merge rolled back and is
 * safe to run again as is.
 */
export const PLACE_MERGE_RETRY = "PLACE_MERGE_RETRY";

/** `pendingObjectDeletions.source` for the merged page's images. */
export const PLACE_MERGE_DELETION_SOURCE = "place_merge";

/**
 * Postgres deadlock (40P01) or serialization failure (40001), however the
 * driver wraps it: Prisma's P2034, or the pg / driver-adapter code on the
 * error, its `meta` or its `cause` chain.
 */
function isDeadlockError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 5) return false;
  const e = err as {
    code?: unknown;
    meta?: { code?: unknown; driverAdapterError?: unknown };
    cause?: unknown;
    message?: unknown;
  };
  const codes = [e.code, e.meta?.code];
  if (codes.some((c) => c === "P2034" || c === "40P01" || c === "40001")) {
    return true;
  }
  if (typeof e.message === "string" && /deadlock detected/i.test(e.message)) {
    return true;
  }
  return (
    isDeadlockError(e.meta?.driverAdapterError, depth + 1) ||
    isDeadlockError(e.cause, depth + 1)
  );
}

/** Dates → ISO so the audit JSON is stable whatever the driver does. */
function auditRow(row: PlaceMergeRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Date ? v.toISOString() : v,
    ]),
  );
}

export async function mergePlaces(
  deps: MergePlacesDeps,
  rawInput: unknown,
): Promise<MergePlacesOutput> {
  const input = parseInput(mergePlacesInputSchema, rawInput);
  await requirePlaceMergeAdmin(deps.authz, input.actorHumanId);
  assertDistinctPlaces(input.survivorId, input.mergedId);

  const at = deps.clock.now();
  const { survivorId, mergedId } = input;
  const lockOrder = [survivorId, mergedId].sort();

  // The merge takes the place / calendar / page row locks in a fixed order,
  // but other writers lock some of the same rows in another order
  // (`publishPageDraft` takes the PageDraft row, then the EntityPage). When
  // Postgres picks the merge as the deadlock victim the whole transaction has
  // already rolled back; it is rethrown as a typed, retryable refusal rather
  // than an INTERNAL. Not a swallow: every path out of the catch throws.
  const runMerge = () => deps.repos.tx(async (tx) => {
    // 1. Locks. Hold lines first: the global order puts hold-line before
    //    every other lock (save-event-shared.ts note 4; the accept mint
    //    holds lines when it takes place_location shared). A placer takes the
    //    line lock, reads the line, then inserts at length + 1; a Calendar
    //    row lock only delays that INSERT, not the read, so without the line
    //    lock a placer could count an empty survivor line, wait, and insert a
    //    second position-1 hold after the merge moved one in.
    const lineKeys = sortLineKeys(
      await tx.placeMerge.listFoldLineKeys({ survivorId, mergedId }),
    );
    await lockLines(tx, lineKeys);
    // Event-location advisory lock next, as `upsertPlace` does before it
    // writes a Place row: an in-flight event save at either place commits
    // first, and a later one reads the merged state.
    for (const placeId of lockOrder) {
      await tx.events.lockLocationsAtPlace({ placeId, mode: "exclusive" });
    }
    await tx.placeMerge.lockForMerge({ placeIds: lockOrder, lineKeys });

    // 2. Decide under the lock.
    const lockedLines = new Set(lineKeys.map((k) => `${k.calendarId}|${k.date}`));
    const linesNow = await tx.placeMerge.listFoldLineKeys({ survivorId, mergedId });
    if (linesNow.some((k) => !lockedLines.has(`${k.calendarId}|${k.date}`))) {
      // A hold landed on a new day before the calendar lock: its line is not
      // locked, so the overlap check below could race. Roll back; a rerun
      // reads the new day first.
      throw fail("CONFLICT", {
        message: PLACE_MERGE_RETRY,
        meta: { reason: PLACE_MERGE_RETRY },
      });
    }
    const plan = await readPlaceMergePlan(tx, { survivorId, mergedId });
    if (plan.blockers.length > 0) {
      throw fail("CONFLICT", {
        message: PLACE_MERGE_BLOCKED,
        meta: { reason: PLACE_MERGE_BLOCKED, blockers: plan.blockers },
      });
    }
    const { survivor, merged } = plan;

    // 3a. Fill (D2).
    await tx.placeMerge.fillFields(survivorId, plan.fill.patch);

    // 3b. Re-point (FR-003). One calendar / space map, from the fold
    //     decision, for both 3b and 3b' so they cannot drift: when the
    //     survivor has no default calendar the merged one moves whole in 3b'
    //     (events keep their calendarId) instead of folding.
    const calendarMap =
      plan.reparent.fold && merged.defaultCalendarId && survivor.defaultCalendarId
        ? { from: merged.defaultCalendarId, to: survivor.defaultCalendarId }
        : null;
    const spaceMap =
      plan.reparent.fold && merged.mainSpaceId && survivor.mainSpaceId
        ? { from: merged.mainSpaceId, to: survivor.mainSpaceId }
        : null;
    const dropOwnershipIds = planOwnershipDrops(survivor, merged);
    const repointOwnershipIds = planOwnershipRepoints(survivor, merged);
    const repointed = await tx.placeMerge.repointPlaceRows({
      survivorId,
      mergedId,
      calendar: calendarMap,
      space: spaceMap,
      dropOwnershipIds,
      repointOwnershipIds,
    });

    // 3b'. Booking and operations rows (FR-003b, owner ruling 2026-10-15).
    //      After the events have left the merged default calendar / Main
    //      Space (3b), so the folded calendar and space are empty when the
    //      adapter deletes them.
    const operations = await tx.placeMerge.moveOperations({
      survivorId,
      mergedId,
      calendar: calendarMap,
      space: spaceMap,
      reparentCalendars: plan.reparent.calendars,
      reparentSpaces: plan.reparent.spaces,
      layouts: plan.reparent.layouts,
      dropStandardItems: plan.standards.dropItems,
      dropPitchExamples: plan.standards.dropExamples,
      deactivateMergedWaivers: deactivatesMergedWaivers(
        plan.counts,
        plan.ownersCompatible,
      ),
      revokeMergedGrants: plan.grants.revoke,
      splitWholePlaceGrantsOnto: plan.grants.splitOnto,
      revokeWholePlaceGrants: plan.grants.revokeWholePlace,
      now: at,
    });

    // 3c. Page (FR-004).
    let pageMoved: Awaited<
      ReturnType<typeof tx.placeMerge.repointPageRows>
    > | null = null;
    let pageImageKeysEnqueued: string[] = [];
    if (plan.pageAction === "MOVE_TO_SURVIVOR_PAGE" && survivor.page && merged.page) {
      pageMoved = await tx.placeMerge.repointPageRows({
        fromPageId: merged.page.id,
        toPageId: survivor.page.id,
      });
      // The merged page's live slug redirects to the survivor once the page
      // is gone (`getBySlug` checks live pages before history).
      await tx.entityPages.recordSlugHistory(survivor.page.id, merged.page.slug);
      pageImageKeysEnqueued = await enqueuePageImageDeletions(
        tx,
        mergedId,
        merged.page.id,
      );
      await tx.placeMerge.deletePage(merged.page.id);
    } else if (plan.pageAction === "TRANSFER_PAGE" && merged.page) {
      await tx.placeMerge.transferPage({
        pageId: merged.page.id,
        toPlaceId: survivorId,
      });
    }

    // 3d. Arrival areas (arrival-areas FR-012): by UPDATE, ids kept, so the
    //     hides that point at them keep pointing; before 5's delete, which
    //     would CASCADE them. The limit was checked in 2, under the lock.
    const arrivalAreasMoved = await moveArrivalAreasForPlaceMerge(tx, {
      survivorId,
      mergedId,
      mergedRows: plan.arrivalAreas.merged,
      actorHumanId: input.actorHumanId,
      now: at,
    });

    // 4. Re-project event locations from the survivor's (filled) row.
    const addressFilled = plan.fill.filledFields.some((f) =>
      (ADDRESS_GROUP_FIELDS as readonly PlaceMergeFillField[]).includes(f),
    );
    let reprojectedEventIds: string[] = [];
    let arrivalAreaEvents: Awaited<
      ReturnType<typeof onEventsMovedByPlaceMerge>
    > = { disabledIds: [], removedHideIds: [], conflictIds: [] };
    if (repointed.events.length > 0 || addressFilled) {
      const survivorRecord = await tx.places.getById(survivorId);
      if (!survivorRecord) throw fail("PLACE_NOT_FOUND");
      reprojectedEventIds = await tx.events.reprojectLocationForPlace({
        placeId: survivorId,
        projection: projectPlaceLocationForEvents(survivorRecord),
        now: at,
        defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
      });
      // 4b. The moved events' own arrival areas (FR-014, after 3d so a hide
      //     of a moved area is a hide of a survivor area). The events moved
      //     with their place, not to another one: only areas the survivor's
      //     pin no longer covers switch off.
      if (repointed.events.length > 0) {
        arrivalAreaEvents = await onEventsMovedByPlaceMerge(tx, {
          eventIds: repointed.events,
          survivorId,
          mergedId,
          survivorPin:
            typeof survivorRecord.lat === "number" &&
            typeof survivorRecord.lng === "number"
              ? { lat: survivorRecord.lat, lng: survivorRecord.lng }
              : null,
          actorHumanId: input.actorHumanId,
          now: at,
        });
        if (arrivalAreaEvents.conflictIds.length > 0) {
          // A concurrent area write on an event this merge holds: roll back.
          throw fail("CONFLICT", {
            message: PLACE_MERGE_RETRY,
            meta: { reason: PLACE_MERGE_RETRY },
          });
        }
      }
    }

    // 5. Derived rows (FR-005). The survivor's ReviewAggregate(PLACE) needs no
    //    stale mark: the weekly recompute-review-aggregates job rebuilds every
    //    subject with reviews (computedAt does not pick subjects), and the
    //    survivor now holds the moved ones.
    await tx.placeMerge.markPlaceStatsStale(survivorId);
    await tx.placeMerge.deleteDerivedRows(mergedId);

    const movedIds = {
      ...repointed,
      follows: pageMoved?.follows ?? [],
      followsDropped: pageMoved?.followsDropped ?? [],
      eventNotices: pageMoved?.eventNotices ?? [],
      eventNoticesDropped: pageMoved?.eventNoticesDropped ?? [],
      pageSlugHistory: pageMoved?.pageSlugHistory ?? [],
      // Full rows of every row a unique collision dropped (reversal record).
      droppedRows: {
        ...repointed.droppedRows,
        follows: pageMoved?.droppedRows.follows ?? [],
        eventNotices: pageMoved?.droppedRows.eventNotices ?? [],
      },
    };

    // FR-007: enough to reverse the merge by a deliberate later build (D5).
    await tx.audit.log({
      entity: "Place",
      entityId: survivorId,
      action: "place.merged",
      data: {
        actorHumanId: input.actorHumanId,
        survivorId,
        mergedId,
        mergedPlace: auditRow(merged.place),
        mergedPageId: merged.page?.id ?? null,
        mergedPageSlug: merged.page?.slug ?? null,
        survivorPageId: survivor.page?.id ?? null,
        pageAction: plan.pageAction,
        mergedDefaultCalendarId: merged.defaultCalendarId,
        mergedMainSpaceId: merged.mainSpaceId,
        filledFields: plan.fill.filledFields,
        survivorValuesBeforeFill: Object.fromEntries(
          plan.fill.filledFields.map((f) => {
            const v = survivor.place[f];
            return [f, v instanceof Date ? v.toISOString() : v];
          }),
        ),
        mergedOwnerships: merged.ownerships,
        // Each dropped ownership with the kept row of the same owner (closed
        // verification requests were re-pointed from → to).
        repointOwnershipIds,
        ownersCompatible: plan.ownersCompatible,
        movedIds,
        // FR-003b: what a manual reversal needs to put booking data back.
        operations: {
          defaultCalendarFolded: plan.reparent.fold,
          survivorDefaultCalendarId: survivor.defaultCalendarId,
          survivorMainSpaceId: survivor.mainSpaceId,
          renames: plan.reparent.renames,
          payoutTerms: {
            survivorBefore: {
              defaultPrimaryPayoutTermsId: survivor.place.defaultPrimaryPayoutTermsId,
              defaultResalePayoutTermsId: survivor.place.defaultResalePayoutTermsId,
            },
            merged: {
              defaultPrimaryPayoutTermsId: merged.place.defaultPrimaryPayoutTermsId,
              defaultResalePayoutTermsId: merged.place.defaultResalePayoutTermsId,
            },
            filled: plan.fill.filledFields.filter((f) =>
              (PAYOUT_DEFAULT_FIELDS as readonly string[]).includes(f),
            ),
            // Owners not compatible: the merged deals were not carried.
            carried: plan.ownersCompatible,
          },
          warnings: plan.warnings,
          ...operations,
        },
        reprojectedEventIds,
        pageImageKeysEnqueued,
        // arrival-areas FR-012 / FR-014 (each area also has its own row).
        arrivalAreas: {
          movedIds: arrivalAreasMoved.movedIds,
          disabledIds: arrivalAreaEvents.disabledIds,
          removedHideIds: arrivalAreaEvents.removedHideIds,
        },
      },
      at,
    });

    // Search: both places (the merged one's document is removed by the
    // reindex, since the row is gone) and every event whose document names
    // the place or its location.
    const eventIds = new Set([
      ...repointed.events,
      ...repointed.venueConfirmedEvents,
      ...reprojectedEventIds,
      ...operations.eventsOnReparentedCalendars,
    ]);
    await markForSearchReindex(
      tx,
      [
        { kind: "place", id: survivorId },
        { kind: "place", id: mergedId },
        ...[...eventIds].map((id) => ({ kind: "event" as const, id })),
      ],
      at,
    );

    await tx.placeMerge.deletePlace(mergedId);

    return {
      pageAction: plan.pageAction,
      filledFields: plan.fill.filledFields,
      moved: {
        ...plan.counts.moves,
        // Actual counts from the writes, not the pre-read.
        events: repointed.events.length,
        venueConfirmedEvents: repointed.venueConfirmedEvents.length,
        eventsOnDefaultCalendar: repointed.eventsCalendarRepointed.length,
        eventsOnMainSpace: repointed.eventsSpaceRepointed.length,
        attendeeReviews: repointed.attendeeReviews.length,
        postEventPrompts: repointed.postEventPrompts.length,
        membershipBenefits: repointed.membershipBenefits.length,
        savedLocations: repointed.savedLocations.length,
        placeReviews: repointed.placeReviews.length,
        placeReviewSessions: repointed.placeReviewSessions.length,
        placeReviewSessionsDropped: repointed.placeReviewSessionsDropped.length,
        volunteerAsks: repointed.volunteerAsks.length,
        entityReports: repointed.entityReports.length,
        entityReportsDropped: repointed.entityReportsDropped.length,
        featuredItems: repointed.featuredItems.length,
        featuredItemsDropped: repointed.featuredItemsDropped.length,
        embeds: repointed.embeds.length,
        verificationRequests: repointed.verificationRequests.length,
        follows: movedIds.follows.length,
        followsDropped: movedIds.followsDropped.length,
        eventNotices: movedIds.eventNotices.length,
        eventNoticesDropped: movedIds.eventNoticesDropped.length,
        pageSlugHistory: movedIds.pageSlugHistory.length,
        ownerships: repointed.ownerships.length,
        ownershipsDropped: repointed.ownershipsDropped.length,
        bookingRequests: operations.bookingRequests.length,
        agreements: operations.agreements.length,
        bookingGrants: operations.bookingGrants.length,
        waivers: operations.waivers.length,
        posReaders: operations.posReaders.length,
        layouts: operations.layouts.length,
        calendarAvailability: operations.calendarAvailability.length,
        bookingHolds: operations.bookingHolds.length,
        calendarsReparented: operations.calendarsReparented.length,
        spacesReparented: operations.spacesReparented.length,
        defaultCalendarFolded: operations.deletedCalendar ? 1 : 0,
        bookingStandardItems: operations.bookingStandardItems.length,
        bookingStandardItemsDropped: operations.bookingStandardItemsDropped.length,
        bookingPitchExamples: operations.bookingPitchExamples.length,
        bookingPitchExamplesDropped: operations.bookingPitchExamplesDropped.length,
        series: operations.series.length,
        templates: operations.templates.length,
        occurrences: operations.occurrences.length,
        bookingGrantsRevoked: operations.bookingGrantsRevoked.length,
        bookingGrantsSplit: operations.bookingGrantsSplit.length,
        imageModerationRecords: repointed.imageModerationRecords.length,
        arrivalAreas: arrivalAreasMoved.movedIds.length,
      },
      warnings: plan.warnings,
      eventsReprojected: reprojectedEventIds.length,
      eventArrivalAreasSwitchedOff: arrivalAreaEvents.disabledIds.length,
    };
  });

  let result: Awaited<ReturnType<typeof runMerge>>;
  try {
    result = await runMerge();
  } catch (err) {
    if (!isAppError(err) && isDeadlockError(err)) {
      throw fail("CONFLICT", {
        message: PLACE_MERGE_RETRY,
        meta: { reason: PLACE_MERGE_RETRY },
        cause: err,
      });
    }
    throw err;
  }

  // After commit: refresh both place documents now rather than at the next
  // drain (the marks above are the durable backstop). Never throws.
  const reindexDeps = {
    repos: deps.repos,
    search: deps.search,
    clock: deps.clock,
    logger: deps.logger,
    reportError: deps.reportError,
  };
  reindexAfterMutation(reindexDeps, "mergePlaces", {
    kind: "place",
    id: survivorId,
  });
  reindexAfterMutation(reindexDeps, "mergePlaces", {
    kind: "place",
    id: mergedId,
  });

  deps.logger?.info("mergePlaces.merged", {
    survivorId,
    mergedId,
    events: result.moved.events,
    bookingHolds: result.moved.bookingHolds,
    bookingRequests: result.moved.bookingRequests,
    pageAction: result.pageAction,
  });

  return mergePlacesOutputSchema.parse({ survivorId, mergedId, ...result });
}

/**
 * Enqueue the merged page's uploaded images for deletion, in the merge's
 * transaction (the transactional outbox `executeHumanDeletionTx` and
 * `discardPageDraft` use): avatar, banner, theme, every block and the draft.
 *
 * Only keys under the MERGED place's own page prefix
 * (`entity-pages/place/<mergedId>/`) are taken, so a URL pointing at another
 * entity's object can never be enqueued. Inside that prefix the generous
 * matcher is safe: the page that owned the prefix is being deleted, so
 * nothing live can still need an object there, and a candidate key that does
 * not exist costs one no-op delete.
 */
async function enqueuePageImageDeletions(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  mergedId: string,
  pageId: string,
): Promise<string[]> {
  const [page, theme, blocks, draft] = await Promise.all([
    tx.entityPages.getById(pageId),
    tx.entityPages.getTheme(pageId),
    tx.entityPages.listBlocks(pageId),
    tx.entityPages.getDraft(pageId),
  ]);
  const keys = pageImageKeysMentionedIn(
    [page, theme, blocks.map((b) => b.data), draft?.data, draft?.placePatch],
    getEntityPageImageKeyPrefix("PLACE", mergedId),
  );
  if (keys.length === 0) return keys;
  const items: EnqueuePendingObjectDeletionItem[] = keys.map((targetKey) => ({
    targetKey,
    targetKind: "KEY",
    source: PLACE_MERGE_DELETION_SOURCE,
    sourceId: mergedId,
  }));
  await tx.pendingObjectDeletions.enqueueMany(items);
  return keys;
}
