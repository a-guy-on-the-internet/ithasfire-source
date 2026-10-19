import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { MultiSearchIndexPort } from "@th/ports/search/multi-index.port";
import { fail } from "@th/errors";

import { isTxBoundSearch } from "./tx-bound-search";

import {
  projectPublicEventLocation,
  unreadablePlaceLocation,
  type PublicEventLocation,
  type PublicEventLocationSource,
} from "../../lib/location/project-public-event-location";
import { placeEventProjectionChanged } from "../../lib/location/place-event-location";
import {
  placeWithholdsAddress,
  type PlaceLocationSource,
} from "../../lib/location/redact-place-location";

/**
 * FAIL-CLOSED SEARCH SCRUB for a location that just became more private (and
 * for an event leaving public view: unpublish, delete, a non-PUBLIC
 * visibility).
 *
 * The search index is queried anonymously and plots venues and events on a
 * public map. Its documents hold whatever public projection was current when
 * they were last written, and the normal refresh after a mutation
 * (`reindexAfterMutation`) is BEST-EFFORT: if it fails, the old document keeps
 * serving until the nightly `search.full-reindex`. For most edits that is only
 * staleness. When a venue or event WITHDRAWS its address, the old document is
 * the exact pin the owner just asked us to take down.
 *
 * So a save that lands on a withheld location deletes the affected documents
 * INSIDE its transaction callback, after every write and before the commit,
 * and throws if the delete fails. The transaction rolls back and the caller
 * sees the retryable `SEARCH_UPDATE_RETRY`.
 *
 * ON POSTGRES (both environments) the callers pass `searchForTx(search, tx)`,
 * so the DELETE runs on the saving transaction's own connection and is
 * ATOMIC with the save: either both commit, or neither does. A failed DELETE
 * aborts the transaction, and the throw rolls it back.
 *
 * ON AN EXTERNAL ENGINE (Meilisearch) the DELETE cannot join the
 * transaction, and the end states are:
 *
 *   · commit, documents gone     → the post-commit reindex writes the
 *                                  redacted documents back (nightly if that
 *                                  fails, reported either way);
 *   · rollback, documents kept   → the delete failed before removing
 *                                  anything; nothing changed;
 *   · rollback, SOME documents   → the delete is sent in chunks of
 *     gone                         {@link SCRUB_CHUNK} ids; if a later chunk
 *                                  fails, earlier chunks are already gone.
 *                                  Over-private until the next reindex.
 *                                  Never a leak;
 *   · rollback, documents gone   → the delete succeeded and the COMMIT then
 *                                  failed. Same over-private outcome.
 *
 * WHAT MAKES THAT HOLD AGAINST CONCURRENT INDEXERS is not this file: it is the
 * index-write fence in `buildSearchIndex` (`withIndexWriteFence`). Without it,
 * an indexer that read the rows before this save committed could write the
 * old document back after the delete. With it, such an indexer either
 * finishes its write before this save can take its locks (and the delete
 * then removes it) or waits for this save to commit and reads the new state.
 *
 * WHAT IT DOES NOT COVER. Writers that bypass these use cases: operator
 * scripts that update Place/Event rows directly, and a hand-run reindex from
 * a process started before a deploy. Those rely on the fence alone (their
 * index writes are fenced) and on the nightly reindex.
 *
 * Only changes that END withheld need this. A venue or event that goes back
 * to EXACT publishes that address on purpose, so a stale withheld document
 * reveals nothing and the best-effort refresh is enough.
 *
 * The delete goes through `MultiSearchIndexPort` either way, so both
 * backends share this code; `searchForTx` decides which connection it uses.
 */

/** Search document id of a place. Same key `buildSearchIndex` writes. */
export function placeSearchDocId(placeId: string): string {
  return `place_${placeId}`;
}

/** Search document id of an event. Same key `buildSearchIndex` writes. */
export function eventSearchDocId(eventId: string): string {
  return `event_${eventId}`;
}

/**
 * The venue's public location changed AND it now withholds its address:
 * EXACT → withheld, a bigger or smaller circle, hidden, a moved point or a new
 * area label while withheld. Withheld → EXACT is not a scrub (see module doc).
 */
export function placeLocationScrubNeeded(
  before: PlaceLocationSource,
  after: PlaceLocationSource,
): boolean {
  return (
    placeWithholdsAddress(after) && placeEventProjectionChanged(before, after)
  );
}

/**
 * The event's PUBLIC projection (`projectPublicEventLocation`, with its venue
 * and its gate) changed, and the new one is not an exact pin. Covers the
 * event's own OBSCURED / hidden / radius change, a gate being added, and a
 * move onto a withheld venue. A change that lands on an exact, ungated pin
 * publishes that pin deliberately and needs no scrub.
 */
export function eventLocationScrubNeeded(
  before: PublicEventLocation,
  after: PublicEventLocation,
): boolean {
  if (after.mode === "EXACT" && !after.hidden) return false;
  return (
    before.mode !== after.mode ||
    before.hidden !== after.hidden ||
    before.lat !== after.lat ||
    before.lng !== after.lng ||
    before.radiusMeters !== after.radiusMeters ||
    before.addressText !== after.addressText ||
    before.postalCode !== after.postalCode ||
    before.label !== after.label ||
    before.areaLabel !== after.areaLabel
  );
}

/** Ids per delete call. Postgres takes them as one `ANY($1)` array. */
export const SCRUB_CHUNK = 1000;

type ScrubInput = {
  docIds: string[];
  useCase: string;
  logger?: LoggerPort;
  /**
   * Reported BEFORE the throw. The throw maps to a 503, which the API's
   * Sentry hook (500s only) does not capture, and a scrub that cannot run is
   * exactly the failure that has to be seen.
   */
  reportError?: ReporterPort;
};

/**
 * Delete `docIds` from the search index, or THROW. Call it as the LAST step
 * inside the transaction callback of the save that tightened the location
 * (see module doc for why that position matters).
 *
 * Returns `true` when it deleted (so the caller knows to run its post-commit
 * reindex) and `false` when there was nothing to do: no ids, or no search
 * port configured (no index, nothing to leak).
 *
 * Throws `SEARCH_UPDATE_RETRY` (user-facing, "please try again") when the
 * port returns an error or throws, after reporting it. That is not a swallow:
 * the error propagates and fails the save.
 */
export async function scrubSearchDocumentsOrThrow(
  search: Pick<MultiSearchIndexPort, "deleteDocuments"> | undefined,
  input: ScrubInput,
): Promise<boolean> {
  const failure = await deleteInChunks(search, input);
  if (failure === NOTHING_TO_DO) return false;
  if (failure === null) return true;
  throw fail("SEARCH_UPDATE_RETRY", {
    meta: { useCase: input.useCase, docCount: input.docIds.length },
    cause: failure,
  });
}

/**
 * NEVER pass a transaction-bound port (`searchForTx`) here: a failed DELETE
 * inside a Postgres transaction aborts it and its COMMIT silently rolls back.
 *
 * The same delete, for the one caller that must NOT fail: `cancelEvent`,
 * whose Stripe refunds have already been issued before its transaction opens.
 * Rolling that transaction back would leave buyers refunded and the event
 * still on sale, which is worse than a cancelled listing lingering in search
 * (the post-commit reindex removes it again; no location is involved). A
 * failure is REPORTED (ReporterPort convention) and returns `false`.
 */
export async function scrubSearchDocumentsOrReport(
  search: Pick<MultiSearchIndexPort, "deleteDocuments"> | undefined,
  input: ScrubInput,
): Promise<boolean> {
  if (isTxBoundSearch(search)) {
    // Programmer error, loud on purpose: see the note above. A report-only
    // DELETE that failed inside the caller's transaction would silently turn
    // its COMMIT into a ROLLBACK.
    throw new Error(
      "scrubSearchDocumentsOrReport: handed a transaction-bound search port; pass the port itself (deps.search)",
    );
  }
  const failure = await deleteInChunks(search, input);
  if (failure === NOTHING_TO_DO) return false;
  return failure === null;
}

const NOTHING_TO_DO: unique symbol = Symbol("nothing_to_do");

/**
 * `null` = deleted, {@link NOTHING_TO_DO} = no ids or no port, anything else =
 * the failure (already logged and reported).
 */
async function deleteInChunks(
  search: Pick<MultiSearchIndexPort, "deleteDocuments"> | undefined,
  input: ScrubInput,
): Promise<unknown> {
  const docIds = [...new Set(input.docIds)];
  if (!search || docIds.length === 0) return NOTHING_TO_DO;

  for (let i = 0; i < docIds.length; i += SCRUB_CHUNK) {
    const chunk = docIds.slice(i, i + SCRUB_CHUNK);
    let failure: unknown = null;
    try {
      const result = await search.deleteDocuments({ ids: chunk });
      if (!result.ok) failure = result.error;
    } catch (err) {
      failure = err;
    }
    if (failure !== null) {
      const deletedBefore = i;
      try {
        input.logger?.error("search.privacy_scrub_failed", {
          useCase: input.useCase,
          docCount: docIds.length,
          deletedBefore,
          error: failure instanceof Error ? failure.message : String(failure),
        });
      } catch {
        // Best-effort.
      }
      try {
        input.reportError?.(failure, {
          tags: { useCase: input.useCase, op: "searchPrivacyScrub" },
          extra: { docCount: docIds.length, deletedBefore },
        });
      } catch {
        // Best-effort: a throwing reporter must not change the outcome.
      }
      return failure;
    }
  }

  input.logger?.info("search.privacy_scrubbed", {
    useCase: input.useCase,
    docCount: docIds.length,
  });
  return null;
}

/** An event row as the scrub reads it: the projection's fields + its venue. */
export type ScrubEventRow = PublicEventLocationSource & {
  placeId?: string | null;
};

/**
 * The event half of the scrub, for saves that change an EXISTING event's
 * location or gate. Projects `before` and `after` through the same public
 * projection the index uses (venue floor + gate) and, when
 * {@link eventLocationScrubNeeded} says so, deletes the event's document or
 * throws. Same call position as {@link scrubSearchDocumentsOrThrow}: last
 * step in the transaction callback, `places` being the transaction's repo.
 *
 * Both projections read the venue as it is NOW. The venue's own privacy
 * changes go through `upsertPlace`, which scrubs its events itself; here only
 * the event (or which venue it points at) moved.
 */
export async function scrubEventSearchDocIfWithheld(args: {
  search: Pick<MultiSearchIndexPort, "deleteDocuments"> | undefined;
  places: Pick<PlacesRepo, "getById">;
  before: ScrubEventRow;
  after: ScrubEventRow;
  useCase: string;
  logger?: LoggerPort;
  reportError?: ReporterPort;
}): Promise<boolean> {
  if (!args.search) return false;

  const placeCache = new Map<string, Awaited<ReturnType<typeof readPlace>>>();
  async function readPlace(placeId: string) {
    const row = await args.places.getById(placeId);
    return row ?? unreadablePlaceLocation(placeId);
  }
  async function project(row: ScrubEventRow): Promise<PublicEventLocation> {
    const placeId = row.placeId ?? null;
    if (placeId === null) return projectPublicEventLocation(row);
    let place = placeCache.get(placeId);
    if (!place) {
      place = await readPlace(placeId);
      placeCache.set(placeId, place);
    }
    return projectPublicEventLocation(row, { place });
  }

  const [before, after] = [await project(args.before), await project(args.after)];
  if (!eventLocationScrubNeeded(before, after)) return false;

  return scrubSearchDocumentsOrThrow(args.search, {
    docIds: [eventSearchDocId(args.after.id)],
    useCase: args.useCase,
    logger: args.logger,
    reportError: args.reportError,
  });
}
