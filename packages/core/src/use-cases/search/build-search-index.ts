/**
 * Build Search Index Use Case
 *
 * Indexes events, humans, places, and organizations into the search engine.
 * Can index individual documents or perform a full reindex.
 */
import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type {
  SearchSweepToken,
  EventSearchDocument,
  HumanSearchDocument,
  PlaceSearchDocument,
  OrganizationSearchDocument,
  MultiSearchDocument,
} from "@th/ports/search/multi-index.types";

import type { EventLocationMode, EventVisibility } from "@th/types";
import type { PageVisibility } from "@th/types/repos/entity-pages";

import { crawlablePageSlug } from "../../lib/entity-page-visibility";
import { parseInput } from "../../lib/io";
import {
  cardVenueName,
  resolveVenueConfirmationByEvent,
} from "../../lib/venue-confirmation";
import { projectPublicEventLocation } from "../../lib/location/project-public-event-location";
import {
  redactPlaceLocation,
  type PlaceLocationSource,
} from "../../lib/location/redact-place-location";
import { resolveTimeZone } from "../../lib/venue-local-time";
import { loadListingBuyerTotalsByEventId } from "../events/_shared/listing-buyer-totals";
import {
  summarizePricing,
  type FacePricingSummary,
} from "../events/_shared/event-pricing";
import { resolveVisibleImageKeys } from "../moderation/gate-image-visibility";
import { bindSearchToTx } from "./tx-bound-search";
import { categoryNames, type CategoryNameTranslations } from "@th/types";

// ─────────────────────────────────────────────────────────────────────────────
// Input/Output Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Largest nightly page. A page is ONE index-write-fence transaction (default
 * 30s timeout) that holds share locks on its rows while it builds, so the
 * page size bounds both the timeout risk and how long a save of one of those
 * events can wait.
 */
export const MAX_INDEX_BATCH_SIZE = 200;

export const buildSearchIndexInputSchema = z
  .object({
    /** Index specific event IDs */
    eventIds: z.array(z.string().uuid()).optional(),
    /** Index specific human IDs */
    humanIds: z.array(z.string().uuid()).optional(),
    /** Index specific place IDs */
    placeIds: z.array(z.string().uuid()).optional(),
    /** Index specific organization IDs */
    organizationIds: z.array(z.string().uuid()).optional(),
    /** Full reindex of all entities */
    fullReindex: z.boolean().default(false),
    /**
     * Batch size for full reindex. Capped at {@link MAX_INDEX_BATCH_SIZE}:
     * each event/place page is built inside one index-write-fence transaction
     * (30s budget), holding its entities' locks for the page's build time.
     */
    batchSize: z.number().int().min(1).max(MAX_INDEX_BATCH_SIZE).default(100),
  })
  .strict();

export const buildSearchIndexOutputSchema = z
  .object({
    eventsIndexed: z.number().int(),
    humansIndexed: z.number().int(),
    placesIndexed: z.number().int(),
    organizationsIndexed: z.number().int(),
    errors: z.array(
      z.object({
        type: z.enum(["event", "human", "place", "organization"]),
        id: z.string(),
        error: z.string(),
      }),
    ),
    /**
     * Full reindex only: the types whose stale-document SWEEP ran and
     * succeeded. A type missing here still serves documents nothing rewrote
     * (entities that stopped being searchable), so work that assumes "the
     * rebuild refreshed this type completely" — clearing its pending marks —
     * must be limited to these. Empty when the sweep marker failed.
     */
    sweptTypes: z
      .array(z.enum(["event", "human", "place", "organization"]))
      .optional(),
  })
  .strict();

export type BuildSearchIndexInput = z.infer<typeof buildSearchIndexInputSchema>;
export type BuildSearchIndexOutput = z.infer<
  typeof buildSearchIndexOutputSchema
>;

export type BuildSearchIndexDeps = {
  repos: Repos;
  search: MultiSearchPort;
  /**
   * Best-effort reporter (ReporterPort convention) for this use case's
   * deliberate swallows:
   *  - the venue-confirmation place lookup (`lib/venue-confirmation`
   *    `resolveVenueConfirmedByEvent`): a failed place read degrades that
   *    place's events to address-only (`venueId` null) for this run instead of
   *    failing the batch;
   *  - the entity-page lookup (`fetchEntityPagesForOwners` / `indexPlacesByIds`):
   *    a failed read costs the owner its bio and, for a place, its `pageSlug` —
   *    the only identifier `/places/[slug]` resolves on, so the venue silently
   *    loses its public link in search results.
   * Both degrade invisibly in the index and MUST be visible in Sentry.
   */
  reportError?: ReporterPort;
  /**
   * REQUIRED (FR-003). FR-008 / Q-001 RESOLVED: the index stores the CURRENT
   * EFFECTIVE price — every tier resolved through `resolveUnitPriceCents` at
   * THIS instant — never the raw `priceCents` and never the post-flip price
   * ahead of its time.
   *
   * Indexing the post-flip price early was explicitly rejected: search would
   * advertise a price that is not yet purchasable, which is the same
   * quote-one-charge-another failure R-001 describes, moved to a surface with
   * far more reach.
   *
   * The corollary is that a stored price goes stale the moment a flip happens
   * with no write to the row. `search.reindex-scheduled-price-flips`
   * (apps/jobs) closes that window by re-indexing events whose flip just
   * crossed. This does NOT violate NFR-002: the job does not set a price or
   * make anything purchasable — the price is still resolved at read time
   * everywhere that takes money. The job only refreshes a DERIVED CACHE, which
   * is a side effect and exactly what apps/jobs is for.
   */
  clock: ClockPort;
  logger?: LoggerPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case Implementation
// ─────────────────────────────────────────────────────────────────────────────

export async function buildSearchIndex(
  deps: BuildSearchIndexDeps,
  rawInput: unknown,
): Promise<BuildSearchIndexOutput> {
  const input = parseInput(buildSearchIndexInputSchema, rawInput);

  const result: BuildSearchIndexOutput = {
    eventsIndexed: 0,
    humansIndexed: 0,
    placesIndexed: 0,
    organizationsIndexed: 0,
    errors: [],
  };

  // Ensure indexes exist before indexing
  const ensureResult = await deps.search.ensureIndexes();
  if (!ensureResult.ok) {
    deps.logger?.error("search.ensure_indexes_failed", {
      error: ensureResult.error.message,
    });
    throw new Error(
      `Failed to ensure search indexes: ${ensureResult.error.message}`,
    );
  }

  if (input.fullReindex) {
    deps.logger?.info("search.full_reindex_started", {});

    // NON-DESTRUCTIVE (2026-09-30). The rebuild used to CLEAR every type
    // first, so search, the map and the featured rails served nothing until
    // it refilled them. Now it takes a sweep marker, upserts every live
    // document (each write is stamped by the index's own clock), and after
    // each type's pass deletes that type's documents nothing rewrote — the
    // entities that stopped being searchable. See `sweepUnrewritten`.
    const sweep = await deps.search.beginSweep();
    if (!sweep.ok) {
      // Deliberate swallow: the rebuild still refreshes every live document;
      // only the removal of stale ones is skipped this run.
      reportSweepFailure(deps, "beginSweep", null, sweep.error);
    }
    const sweepToken = sweep.ok ? sweep.value : null;
    const sweptTypes: NonNullable<BuildSearchIndexOutput["sweptTypes"]> = [];

    // Index all events
    const eventsResult = await indexAllEvents(deps, input.batchSize);
    result.eventsIndexed = eventsResult.indexed;
    result.errors.push(...eventsResult.errors);
    if (await finishTypePass(deps, sweepToken, "event", eventsResult.errors)) {
      sweptTypes.push("event");
    }

    // Index all humans (with public entity pages)
    const humansResult = await indexAllHumans(deps, input.batchSize);
    result.humansIndexed = humansResult.indexed;
    result.errors.push(...humansResult.errors);
    if (await finishTypePass(deps, sweepToken, "human", humansResult.errors)) {
      sweptTypes.push("human");
    }

    // Index all places
    const placesResult = await indexAllPlaces(deps, input.batchSize);
    result.placesIndexed = placesResult.indexed;
    result.errors.push(...placesResult.errors);
    if (await finishTypePass(deps, sweepToken, "place", placesResult.errors)) {
      sweptTypes.push("place");
    }

    // Index all organizations
    const orgsResult = await indexAllOrganizations(deps, input.batchSize);
    result.organizationsIndexed = orgsResult.indexed;
    result.errors.push(...orgsResult.errors);
    if (
      await finishTypePass(
        deps,
        sweepToken,
        "organization",
        orgsResult.errors,
      )
    ) {
      sweptTypes.push("organization");
    }
    result.sweptTypes = sweptTypes;

    deps.logger?.info("search.full_reindex_completed", {
      eventsIndexed: result.eventsIndexed,
      humansIndexed: result.humansIndexed,
      placesIndexed: result.placesIndexed,
      organizationsIndexed: result.organizationsIndexed,
      errorCount: result.errors.length,
    });
  } else {
    // Index specific documents
    if (input.eventIds?.length) {
      const eventsResult = await indexEventsByIds(deps, input.eventIds);
      result.eventsIndexed = eventsResult.indexed;
      result.errors.push(...eventsResult.errors);
    }

    if (input.humanIds?.length) {
      const humansResult = await indexHumansByIds(deps, input.humanIds);
      result.humansIndexed = humansResult.indexed;
      result.errors.push(...humansResult.errors);
    }

    if (input.placeIds?.length) {
      const placesResult = await indexPlacesByIds(deps, input.placeIds);
      result.placesIndexed = placesResult.indexed;
      result.errors.push(...placesResult.errors);
    }

    if (input.organizationIds?.length) {
      const orgsResult = await indexOrganizationsByIds(
        deps,
        input.organizationIds,
      );
      result.organizationsIndexed = orgsResult.indexed;
      result.errors.push(...orgsResult.errors);
    }

    deps.logger?.info("search.index_completed", {
      eventIds: input.eventIds?.length ?? 0,
      humanIds: input.humanIds?.length ?? 0,
      placeIds: input.placeIds?.length ?? 0,
      organizationIds: input.organizationIds?.length ?? 0,
      eventsIndexed: result.eventsIndexed,
      humansIndexed: result.humansIndexed,
      placesIndexed: result.placesIndexed,
      organizationsIndexed: result.organizationsIndexed,
      errorCount: result.errors.length,
    });
  }

  return buildSearchIndexOutputSchema.parse(result);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Indexing
// ─────────────────────────────────────────────────────────────────────────────

type IndexResult = {
  indexed: number;
  errors: BuildSearchIndexOutput["errors"];
};

/** Attempts before a fence gives up on an event whose venue keeps changing. */
const INDEX_FENCE_ATTEMPTS = 3;

/**
 * THE INDEX-WRITE FENCE. Every document write for events and places happens
 * inside one of these, so a stale read can never land after a privacy scrub.
 *
 * THE RACE IT CLOSES. A save that withholds a location deletes the documents
 * before it commits (`privacy-scrub.ts`). Without a fence, an indexer that
 * READ the rows before that commit (an earlier save's fire-and-forget
 * reindex, the nightly job mid-page) could WRITE after the delete, putting
 * the exact pin back until the next write or the nightly run.
 *
 * HOW. Inside one transaction the fence takes, in this order:
 *   1. `pg_advisory_xact_lock_shared` on `place_location:<placeId>` for every
 *      venue involved, sorted (`events.lockLocationsAtPlace` "shared");
 *   2. `SELECT … FOR SHARE` on the event rows, sorted by id (`events.lockRows`).
 * Then it RE-READS the rows through the transaction, builds the documents
 * from what it re-read, awaits the index write, and commits. Every tightening
 * writer conflicts with one of those locks: `upsertPlace` takes the EXCLUSIVE
 * place-location lock as its first statement, and every event-level change
 * (save, gate, visibility, unpublish, cancel, delete) UPDATEs or DELETEs the
 * event row. So exactly one of two orders happens:
 *   · the fence locks first → the tightening waits until the fence has
 *     committed, i.e. until the old document is written, and its scrub then
 *     deletes it;
 *   · the tightening locks first → the fence waits until it commits, and the
 *     re-read (READ COMMITTED: each statement sees the latest commit) returns
 *     the new, withheld state.
 * Either way no old document survives a committed tightening. An event whose
 * venue changed between the hint read and the lock is detected after the
 * re-read (its venue is not locked) and the fence retries with it added.
 *
 * THE WRITE JOINS THE FENCE (Postgres). When the index is the `SearchDocument`
 * table (`indexLivesInPrimaryDatabase`), the fence writes through its OWN
 * transaction (`bindSearchToTx` → `tx.searchDocuments`). If the transaction
 * is rolled back for any reason — Prisma's interactive-transaction timer, an
 * error — the write is rolled back with it. Without that, a write started on
 * a second connection could still land AFTER the rollback had released the
 * locks and a queued save's scrub had run: the race again, by the back door.
 *
 * MEILISEARCH (no transaction to join): the write goes to the engine as
 * before. If the fence's transaction then REJECTS after the write started, the
 * fence runs once more from scratch, re-reading the committed state and
 * overwriting what it wrote. Meilisearch applies an index's tasks in order,
 * so the second write wins.
 *
 * WHY IT CANNOT DEADLOCK. Shared advisory locks never conflict with each
 * other, and FOR SHARE never conflicts with FOR SHARE, so two fences never
 * wait on each other for ENTITY locks. A fence takes all of them before it
 * touches `SearchDocument`. On Postgres its write then takes row locks there,
 * held to commit; two fences writing overlapping documents queue on them, and
 * the bound writer sorts every batch by id so they queue in one order (the
 * write is chunked, 200 rows per INSERT, chunks in that order). A scrub never
 * DELETEs a document while a fence holds it: the scrub's transaction had to
 * get past the same entity lock first (the exclusive venue lock, or the
 * event row UPDATE), which it cannot while that fence is open. Against
 * `upsertPlace`: the cascade holds nothing when it asks for its exclusive
 * lock (first statement), and a fence holds no row locks until it has every
 * advisory lock it wants. Against an event save: the save holds at most the
 * SHARED lock on its venue (which the fence does not wait on) plus its own
 * row, so the fence waits on the save and never the reverse. Checkout is not
 * blocked: order-item / ticket inserts that reference an Event take FOR KEY
 * SHARE on it, which FOR SHARE does not conflict with. The full reindex's
 * per-type SWEEP (`deleteUnswept`, after the type's pass) runs on the port's
 * own connection, in its own autocommit statement: it can wait on a fence's
 * `SearchDocument` row locks (until that fence commits) but holds nothing a
 * fence waits for, so it cannot close a cycle.
 *
 * COST. On Postgres the fence is ONE pool connection (locks, reads, write) for
 * the whole page build; on Meilisearch one connection plus the engine's HTTP
 * call. The build is database reads and in-process arithmetic only (no
 * HTTP). The API's pool is 10 connections per process: the post-save
 * fan-outs are paced (`upsertPlace` re-indexes 2 events at a time) so fences
 * never take more than a small slice of it, and the privacy scrub now runs
 * its DELETE on the saving transaction's own connection too (Postgres), so a
 * save holds one connection, not two (the exception is `cancelEvent`'s
 * report-only scrub, which must stay off its transaction; see there). WHO
 * WAITS: any UPDATE of a fenced
 * Event row, not just privacy changes — a save of that event, publish, the
 * tax-rate self-heal, `setVenueConfirmation`, `markAddressRevealNotified`,
 * slug updates — and `upsertPlace`'s exclusive venue lock. For a single
 * entity that is milliseconds; for a nightly page (at most
 * {@link MAX_INDEX_BATCH_SIZE} rows) it is the page's build time, at 03:00.
 * Splitting the build so only the location fields are rebuilt under the
 * fence would shorten that further, at the price of a second code path for
 * every document field; not worth it at this volume.
 */
async function withIndexWriteFence<Row, T>(
  deps: BuildSearchIndexDeps,
  keys: { eventIds: string[]; placeIds: Array<string | null | undefined> },
  reread: (fenced: BuildSearchIndexDeps) => Promise<Row[]>,
  placeIdOf: (row: Row) => string | null,
  write: (fenced: BuildSearchIndexDeps, rows: Row[]) => Promise<T>,
): Promise<T> {
  const placeIds = new Set(
    keys.placeIds.filter((id): id is string => typeof id === "string"),
  );
  const eventIds = [...new Set(keys.eventIds)].sort();

  let rerunAfterRejection = false;
  for (let attempt = 1; ; attempt += 1) {
    // Set once the write callback starts on a NON-transactional index: a
    // rejection after that point may have left a write in flight.
    let unfencedWriteStarted = false;
    let outcome;
    try {
      outcome = await deps.repos.tx(async (tx) => {
        for (const placeId of [...placeIds].sort()) {
          await tx.events.lockLocationsAtPlace({ placeId, mode: "shared" });
        }
        if (eventIds.length > 0) {
          await tx.events.lockRows({ ids: eventIds, mode: "share" });
        }
        const bound = bindSearchToTx(deps.search, tx);
        const fenced: BuildSearchIndexDeps = {
          ...deps,
          repos: fenceRepos(tx),
          search: bound.inTx ? sortedWrites(bound.search) : bound.search,
        };
        const rows = await reread(fenced);
        const unlocked = rows
          .map(placeIdOf)
          .filter((id): id is string => id !== null && !placeIds.has(id));
        if (unlocked.length > 0) {
          // Commit nothing, release everything, lock the new venue too.
          return { kind: "retry" as const, ids: unlocked };
        }
        unfencedWriteStarted = !bound.inTx;
        return { kind: "done" as const, value: await write(fenced, rows) };
      });
    } catch (err) {
      // Meilisearch: the fence's locks are gone but its write may still land.
      // Run the whole fence once more so the committed state is written LAST.
      if (unfencedWriteStarted && !rerunAfterRejection) {
        rerunAfterRejection = true;
        attempt -= 1;
        continue;
      }
      throw err;
    }
    if (outcome.kind === "done") return outcome.value;
    if (attempt >= INDEX_FENCE_ATTEMPTS) {
      throw new Error(
        `index write fence: venue changed ${INDEX_FENCE_ATTEMPTS} times while indexing (${outcome.ids.join(",")})`,
      );
    }
    for (const id of outcome.ids) placeIds.add(id);
  }
}

/**
 * A transaction-bound search port whose writes are ordered by document id, so
 * two fences writing overlapping documents take the row locks in the same
 * order (see the fence's deadlock note).
 */
function sortedWrites(search: MultiSearchPort): MultiSearchPort {
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return {
    ...search,
    upsertDocuments: (input) =>
      search.upsertDocuments({
        ...input,
        documents: [...input.documents].sort(byId),
      }),
    deleteDocuments: (input) =>
      search.deleteDocuments(
        input.ids ? { ...input, ids: [...input.ids].sort() } : input,
      ),
  };
}

/**
 * The fence's transaction, shaped as `Repos` so the document builders run
 * unchanged against it. `tx` is replaced with a thrower: a builder that
 * opened its own transaction here would escape the fence (and a nested
 * `repos.tx` opens a SECOND connection that can block on this one).
 */
function fenceRepos(tx: TxRepos): Repos {
  return {
    ...tx,
    tx: () => {
      throw new Error("repos.tx called inside the search index write fence");
    },
  } as Repos;
}

/**
 * A whole nightly page failed (its fence threw). Its ids become per-id errors
 * (the job's `success` goes false), the failure is logged and REPORTED
 * (ReporterPort convention: this is a deliberate swallow that lets the rest
 * of the rebuild continue), and the caller moves on to the next page.
 */
function recordPageFailure(
  deps: BuildSearchIndexDeps,
  result: IndexResult,
  type: BuildSearchIndexOutput["errors"][number]["type"],
  ids: string[],
  offset: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  for (const id of ids) {
    result.errors.push({ type, id, error: `page_failed: ${message}` });
  }
  try {
    deps.logger?.error("search.page_index_failed", {
      type,
      offset,
      count: ids.length,
      error: message,
    });
  } catch {
    // Best-effort.
  }
  try {
    deps.reportError?.(err, {
      tags: { useCase: "buildSearchIndex", step: "indexPage" },
      extra: { type, offset, count: ids.length, ids: ids.slice(0, 20) },
    });
  } catch {
    // Best-effort: a throwing reporter must not end the rebuild either.
  }
}

/** Errors that mean a whole page/batch of documents was NOT written. */
export function isPageLevelError(error: string): boolean {
  return error.startsWith("page_failed:") || error.startsWith("upsert_failed:");
}

/**
 * The delete half of the non-destructive rebuild, for one type, after its
 * pass (returns whether it ran and succeeded — see `sweptTypes`): remove the documents written before the sweep marker (nothing
 * rewrote them, so their entity is no longer searchable).
 *
 * SKIPPED when the pass had a PAGE-level failure: those pages' documents
 * were not rewritten either, and sweeping would delete live entities. Per-id
 * content errors do not skip it; their documents are kept (`keepIds`) so a
 * broken entity keeps its previous document instead of vanishing.
 *
 * Deletes only, on the port's own connection: a delete can never publish a
 * location, so it needs no index-write fence. A row a concurrent incremental
 * write is rewriting is locked; the DELETE waits and re-checks the committed
 * row, whose fresh marker keeps it.
 */
async function sweepUnrewritten(
  deps: BuildSearchIndexDeps,
  token: SearchSweepToken | null,
  type: BuildSearchIndexOutput["errors"][number]["type"],
  errors: BuildSearchIndexOutput["errors"],
): Promise<boolean> {
  if (!token) return false;
  if (errors.some((e) => isPageLevelError(e.error))) {
    deps.logger?.info("search.sweep_skipped_page_failures", { type });
    return false;
  }
  const keepIds = errors.map((e) => `${type}_${e.id}`);
  const swept = await deps.search.deleteUnswept({ type, token, keepIds });
  if (!swept.ok) {
    reportSweepFailure(deps, "deleteUnswept", type, swept.error);
    return false;
  }
  deps.logger?.info("search.sweep_completed", {
    type,
    deleted: swept.value.deleted,
    kept: keepIds.length,
  });
  return true;
}

/**
 * End of one type's full-rebuild pass: surface its CONTENT errors, then run
 * its sweep. Returns whether the sweep ran and succeeded (`sweptTypes`).
 */
async function finishTypePass(
  deps: BuildSearchIndexDeps,
  token: SearchSweepToken | null,
  type: BuildSearchIndexOutput["errors"][number]["type"],
  errors: BuildSearchIndexOutput["errors"],
): Promise<boolean> {
  reportContentErrors(deps, type, errors);
  return sweepUnrewritten(deps, token, type, errors);
}

/**
 * Per-id CONTENT errors (a document that could not be built, as opposed to a
 * page that could not be written) are a deliberate swallow: the rebuild keeps
 * those entities' previous documents (`keepIds`), records the format version
 * and returns success. So they MUST reach Sentry — once per type, with the
 * count and a sample of ids — or a format bump that breaks some rows would
 * leave them on the old format silently, with nothing retrying them.
 */
function reportContentErrors(
  deps: BuildSearchIndexDeps,
  type: BuildSearchIndexOutput["errors"][number]["type"],
  errors: BuildSearchIndexOutput["errors"],
): void {
  const content = errors.filter((e) => !isPageLevelError(e.error));
  if (content.length === 0) return;
  const sample = content.slice(0, 20);
  const extra = {
    type,
    count: content.length,
    ids: sample.map((e) => e.id),
    firstError: sample[0]?.error,
  };
  try {
    deps.logger?.error("search.full_reindex_content_errors", extra);
  } catch {
    // Best-effort.
  }
  try {
    deps.reportError?.(
      new Error(
        `buildSearchIndex: ${content.length} ${type} document(s) could not be built`,
      ),
      { tags: { useCase: "buildSearchIndex", step: "contentErrors" }, extra },
    );
  } catch {
    // Best-effort: a throwing reporter must not stop the rebuild.
  }
}

/** Deliberate swallow (the rebuild continues): logged at error AND reported. */
function reportSweepFailure(
  deps: BuildSearchIndexDeps,
  step: "beginSweep" | "deleteUnswept",
  type: string | null,
  err: unknown,
): void {
  try {
    deps.logger?.error("search.sweep_failed", {
      step,
      type,
      error: err instanceof Error ? err.message : String(err),
    });
  } catch {
    // Best-effort.
  }
  try {
    deps.reportError?.(err, {
      tags: { useCase: "buildSearchIndex", step },
      extra: { type },
    });
  } catch {
    // Best-effort: a throwing reporter must not stop the rebuild.
  }
}

/**
 * A failed upsert on the INCREMENTAL path is a per-id failure, not a success
 * with zero indexed. It used to be dropped: the result came back error-free,
 * `reindexAfterMutation` logged "search_indexed", and nothing reached Sentry.
 * That mattered little while the upsert only refreshed a document that was
 * already there. After a privacy scrub (`privacy-scrub.ts`) the upsert is
 * what puts the redacted document BACK, so a silent failure hides the venue
 * from search until the nightly reindex with no signal. Recording it here
 * makes the caller's existing partial-failure report fire.
 */
function recordUpsertFailure(
  result: IndexResult,
  type: BuildSearchIndexOutput["errors"][number]["type"],
  ids: string[],
  message: string,
): void {
  for (const id of ids) {
    result.errors.push({ type, id, error: `upsert_failed: ${message}` });
  }
}

async function indexAllEvents(
  deps: BuildSearchIndexDeps,
  batchSize: number,
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  // KNOWN (pre-existing) GAP — OFFSET pagination. An entity inserted or
  // removed ahead of the cursor while the rebuild runs shifts every later
  // page by one, so one entity can be read twice and another skipped. Now
  // that the rebuild SWEEPS, a skipped live entity's document would be
  // deleted as "not rewritten" — until its next edit's incremental write or
  // the next run puts it back. The fix is keyset pagination (ORDER BY id,
  // WHERE id > last); deliberately not done here. Same for the human, place
  // and organization passes below.
  let offset = 0;
  let hasMore = true;

  // ONE instant for the whole reindex (FR-008). Every event in the run is
  // priced against the same moment, so a long full reindex cannot leave the
  // first and last batches on opposite sides of a flip for the same organizer.
  const indexedAt = deps.clock.now();

  // Build a category-id → slug lookup once (categories are a small set).
  // EVERY category, active or not: the slug tag records which category an
  // event is in, exactly as the incremental path below writes it (`getById`,
  // no active check). `Category.active` is read by the readers
  // (`discoverEventsByCategory`), so switching a category on or off needs no
  // reindex and the two index paths can never disagree about a document.
  const allCategories = await deps.repos.categories.listAll();
  const categorySlugById = new Map(allCategories.map((c) => [c.id, c.slug]));
  const categoryNamesById = new Map(
    allCategories.map((c) => [c.id, categorySearchNames(c)]),
  );

  while (hasMore) {
    // Fetch batch of published events
    const paginatedEvents = await deps.repos.events.listPublished({
      limit: batchSize,
      offset,
    });

    if (paginatedEvents.items.length === 0) {
      hasMore = false;
      break;
    }

    // Build + write the page INSIDE the index-write fence, from rows re-read
    // under it (see `withIndexWriteFence`). The listing above only decides
    // WHICH events are in this page; nothing it returned is written.
    const pageIds = paginatedEvents.items.map((e) => e.id);
    try {
      const page = await withIndexWriteFence(
        deps,
        {
          eventIds: pageIds,
          placeIds: paginatedEvents.items.map((e) => e.placeId ?? null),
        },
        async (fenced) =>
          (await fenced.repos.events.findManyByIds(pageIds)).filter(
            (e) => e.status === "PUBLISHED",
          ),
        (e) => e.placeId ?? null,
        (fenced, items) =>
          indexEventPage(fenced, items, {
            indexedAt,
            categorySlugById,
            categoryNamesById,
            offset,
          }),
      );
      result.indexed += page.indexed;
      result.errors.push(...page.errors);
    } catch (err) {
      // ONE page failing (fence timeout, lock wait, retry exhaustion) must not
      // end the rebuild: the remaining pages still need their refresh. (The
      // type's stale-document sweep is then skipped: this page's documents
      // were not rewritten.)
      recordPageFailure(deps, result, "event", pageIds, offset, err);
    }

    offset += batchSize;
    hasMore = paginatedEvents.items.length === batchSize;
  }

  return result;
}

/**
 * One page of the nightly event reindex: read everything the documents need
 * for `items`, build them, write them. Runs inside `withIndexWriteFence`, so
 * `deps.repos` is the fence's transaction and `items` were re-read under it.
 */
async function indexEventPage(
  deps: BuildSearchIndexDeps,
  items: EventRecord[],
  ctx: {
    indexedAt: Date;
    categorySlugById: ReadonlyMap<string, string>;
    categoryNamesById: ReadonlyMap<string, string[]>;
    offset: number;
  },
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  if (items.length === 0) return result;

  // Fetch popularity stats for this batch
  const eventIds = items.map((e) => e.id);
  const popularityStats =
    await deps.repos.events.getPopularityStats(eventIds);
  const statsMap = new Map(popularityStats.map((s) => [s.eventId, s]));

  // Fetch primary images for this batch, then drop any hero whose moderation
  // record isn't APPROVED (absent record = legacy = visible) so a
  // pending/flagged hero never lands in a public search card.
  const imageRefMap = await deps.repos.images.getPrimaryImageRefs(eventIds);
  const visibleKeys = await resolveVisibleImageKeys(
    deps.repos,
    [...imageRefMap.values()].map((r) => r.key),
  );
  const imageUrlMap = new Map<string, string>();
  for (const [eventId, ref] of imageRefMap) {
    if (visibleKeys.has(ref.key)) imageUrlMap.set(eventId, ref.publicUrl);
  }

  // Fetch ticket-tier pricing for this batch. FR-008: `minPaidPriceCents` is
  // materialised from the EFFECTIVE price at index time (see the note on
  // `BuildSearchIndexDeps.clock`).
  const allTiers =
    await deps.repos.events.listTicketTypesForEventIds(eventIds);
  const tiersByEvent = new Map<string, typeof allTiers>();
  for (const tier of allTiers) {
    const eventTiers = tiersByEvent.get(tier.eventId) ?? [];
    eventTiers.push(tier);
    tiersByEvent.set(tier.eventId, eventTiers);
  }
  const pricingByEvent = summarizeTiersByEvent(tiersByEvent, ctx.indexedAt);
  // Richer form: the flag AND the venue's name, both behind the same gate.
  // The name is what the listing card shows instead of a street address —
  // and only a venue that vouched for the event gets named, plus the
  // name-only display of an unconfirmed community listing (owner ruling
  // 2026-10-06; see the `venueName` line in eventToDocument).
  const venueConfirmationByEvent = await resolveVenueConfirmationByEvent(
    deps,
    items,
    { useCase: "buildSearchIndex" },
  );
  // The all-in buyer total, through THE listing loader the DB-backed browse
  // pages use: same tier set as `summarizePricing` (ACTIVE, on sale at
  // `indexedAt`, PWYW at its floor), taxed at the rate the event page quotes
  // (`resolveQuoteTaxRateBps`), one read per distinct venue, the fee contexts
  // batched. Null when the venue could not be read (TOLERATED and reported,
  // per the reindex's "a doc still ships" posture — but never an all-in price
  // computed from a guessed taxable base). See `loadListingBuyerTotalsByEventId`.
  const lowestBuyerTotalByEvent = await loadListingBuyerTotalsByEventId(
    deps,
    items,
    tiersByEvent,
    ctx.indexedAt,
    { useCase: "buildSearchIndex" },
  );

  const documents: MultiSearchDocument[] = [];

  for (const event of items) {
    try {
      const stats = statsMap.get(event.id);
      const imageUrl = imageUrlMap.get(event.id);
      // `displayPlaceName`, not `placeName`: it also carries the name-only
      // display of an unconfirmed community listing (owner ruling
      // 2026-10-06). `venueId` stays confirmed-only in eventToDocument.
      const venueName =
        venueConfirmationByEvent.get(event.id)?.displayPlaceName ?? null;
      const catSlug = event.categoryId
        ? (ctx.categorySlugById.get(event.categoryId) ?? null)
        : null;
      const pricing = pricingByEvent.get(event.id) ?? EMPTY_PRICING;
      documents.push(
        eventToDocument(
          { ...event, venueName },
          stats,
          imageUrl,
          catSlug,
          pricing,
          lowestBuyerTotalByEvent.get(event.id) ?? null,
          venueConfirmationByEvent.get(event.id)?.confirmed ?? false,
          venueConfirmationByEvent.get(event.id)?.placeLocation ?? null,
          event.categoryId
            ? (ctx.categoryNamesById.get(event.categoryId) ?? [])
            : [],
        ),
      );
    } catch (e) {
      result.errors.push({
        type: "event",
        id: event.id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  if (documents.length > 0) {
    const indexResult = await deps.search.upsertDocuments({ documents });
    if (indexResult.ok) {
      result.indexed += indexResult.value.indexed;
    } else {
      deps.logger?.error("search.batch_index_failed", {
        type: "event",
        offset: ctx.offset,
        error: indexResult.error.message,
      });
      // Per-id errors, so a page whose write failed (on Postgres: whose fence
      // transaction the failed write aborted, dropping the page) never
      // reports `success: true`.
      recordUpsertFailure(
        result,
        "event",
        items.map((e) => e.id),
        indexResult.error.message,
      );
    }
  }

  return result;
}

async function indexEventsByIds(
  deps: BuildSearchIndexDeps,
  eventIds: string[],
): Promise<IndexResult> {
  // Which venues to fence. A hint only: the fence re-reads every row under
  // its locks and retries if an event now points somewhere it did not lock.
  const hint = await deps.repos.events.findManyByIds(eventIds);
  return withIndexWriteFence(
    deps,
    { eventIds, placeIds: hint.map((e) => e.placeId ?? null) },
    (fenced) => fenced.repos.events.findManyByIds(eventIds),
    (e) => e.placeId ?? null,
    (fenced) => indexEventsByIdsInFence(fenced, eventIds),
  );
}

async function indexEventsByIdsInFence(
  deps: BuildSearchIndexDeps,
  eventIds: string[],
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  // ONE instant for this run (FR-008) — see `indexAllEvents`.
  const indexedAt = deps.clock.now();
  const documents: MultiSearchDocument[] = [];
  const publishedEvents: Array<
    NonNullable<Awaited<ReturnType<typeof deps.repos.events.getById>>>
  > = [];
  // Upsert-or-DELETE: the incremental event reindex is the single source of
  // truth for both the publish (upsert) and hide (remove) mutations. A PUBLISHED
  // event is upserted below; ANY other outcome — the event is missing/DELETED,
  // or is DRAFT / CANCELLED / HIDDEN (anything not PUBLISHED) — means a stale doc
  // may be lingering on public surfaces (main search + the search-served embed),
  // so we REMOVE it. Event docs are keyed `event_<id>` (see `eventToDocument`),
  // so removal targets that primary key. Without this, a cancelled/unpublished
  // event would be silently SKIPPED and linger until the nightly full reindex.
  const docIdsToRemove: string[] = [];

  for (const eventId of eventIds) {
    try {
      const event = await deps.repos.events.getById(eventId);
      if (event && event.status === "PUBLISHED") {
        publishedEvents.push(event);
      } else {
        docIdsToRemove.push(`event_${eventId}`);
      }
    } catch (e) {
      result.errors.push({
        type: "event",
        id: eventId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  // Fetch popularity stats for all published events in one call
  if (publishedEvents.length > 0) {
    const popularityStats = await deps.repos.events.getPopularityStats(
      publishedEvents.map((e) => e.id),
    );
    const statsMap = new Map(popularityStats.map((s) => [s.eventId, s]));

    // Fetch primary images for all published events, then drop any hero whose
    // moderation record isn't APPROVED (absent = legacy = visible).
    const imageRefMap = await deps.repos.images.getPrimaryImageRefs(
      publishedEvents.map((e) => e.id),
    );
    const visibleKeys = await resolveVisibleImageKeys(
      deps.repos,
      [...imageRefMap.values()].map((r) => r.key),
    );
    const imageUrlMap = new Map<string, string>();
    for (const [eventId, ref] of imageRefMap) {
      if (visibleKeys.has(ref.key)) imageUrlMap.set(eventId, ref.publicUrl);
    }

    // Fetch ticket-tier pricing for all published events. FR-008: same
    // effective-price-at-index-time rule as the batch path above.
    const allTiers = await deps.repos.events.listTicketTypesForEventIds(
      publishedEvents.map((e) => e.id),
    );
    const tiersByEvent = new Map<string, typeof allTiers>();
    for (const tier of allTiers) {
      const eventTiers = tiersByEvent.get(tier.eventId) ?? [];
      eventTiers.push(tier);
      tiersByEvent.set(tier.eventId, eventTiers);
    }
    const pricingByEvent = summarizeTiersByEvent(tiersByEvent, indexedAt);
    // Same richer resolver as the paginated path above — both indexing paths
    // must name (or refuse to name) a venue identically.
    const venueConfirmationByEvent = await resolveVenueConfirmationByEvent(
      deps,
      publishedEvents,
      { useCase: "buildSearchIndex" },
    );
    // Same loader as the paginated path — both indexing paths must store the
    // same all-in number for the same event.
    const lowestBuyerTotalByEvent = await loadListingBuyerTotalsByEventId(
      deps,
      publishedEvents,
      tiersByEvent,
      indexedAt,
      { useCase: "buildSearchIndex" },
    );

    // Resolve category slugs for the batch
    const uniqueCatIds = [
      ...new Set(
        publishedEvents
          .map((e) => e.categoryId)
          .filter((id): id is string => id != null),
      ),
    ];
    const categorySlugById = new Map<string, string>();
    const categoryNamesById = new Map<string, string[]>();
    for (const catId of uniqueCatIds) {
      const cat = await deps.repos.categories.getById(catId);
      if (cat) {
        categorySlugById.set(cat.id, cat.slug);
        categoryNamesById.set(cat.id, categorySearchNames(cat));
      }
    }

    for (const event of publishedEvents) {
      const stats = statsMap.get(event.id);
      const imageUrl = imageUrlMap.get(event.id);
      const catSlug = event.categoryId
        ? (categorySlugById.get(event.categoryId) ?? null)
        : null;
      const pricing = pricingByEvent.get(event.id) ?? EMPTY_PRICING;
      // `displayPlaceName`, not `placeName`: it also carries the name-only
      // display of an unconfirmed community listing (owner ruling
      // 2026-10-06). `venueId` stays confirmed-only in eventToDocument.
      const venueName =
        venueConfirmationByEvent.get(event.id)?.displayPlaceName ?? null;
      documents.push(
        eventToDocument(
          { ...event, venueName },
          stats,
          imageUrl,
          catSlug,
          pricing,
          lowestBuyerTotalByEvent.get(event.id) ?? null,
          venueConfirmationByEvent.get(event.id)?.confirmed ?? false,
          venueConfirmationByEvent.get(event.id)?.placeLocation ?? null,
          event.categoryId
            ? (categoryNamesById.get(event.categoryId) ?? [])
            : [],
        ),
      );
    }
  }

  if (documents.length > 0) {
    const indexResult = await deps.search.upsertDocuments({ documents });
    if (indexResult.ok) {
      result.indexed = indexResult.value.indexed;
    } else {
      recordUpsertFailure(
        result,
        "event",
        publishedEvents.map((e) => e.id),
        indexResult.error.message,
      );
    }
  }

  // Remove any now-hidden events. Independent of the upsert above (a batch can
  // both upsert some ids and remove others). `logger.error` IS captured by
  // Sentry (pinoIntegration), so a failed deleteDocuments call here is visible
  // rather than a silent warn. NOTE: this only covers a failure of the removal
  // CALL itself — an id that never reached `docIdsToRemove` because `getById`
  // threw earlier is surfaced via `result.errors` and escalated by the caller
  // (`reindexAfterMutation` reports when `result.errors.length > 0`).
  if (docIdsToRemove.length > 0) {
    const deleteResult = await deps.search.deleteDocuments({
      ids: docIdsToRemove,
    });
    if (!deleteResult.ok) {
      deps.logger?.error("search.event_remove_failed", {
        ids: docIdsToRemove,
        error: deleteResult.error.message,
      });
      // A per-id error too, so `reindexAfterMutation` REPORTS it (a log line
      // alone is not a Sentry event). Unpublish / delete / cancel already
      // removed the document before their commit; this is the backstop.
      for (const docId of docIdsToRemove) {
        result.errors.push({
          type: "event",
          id: docId.replace(/^event_/, ""),
          error: `remove_failed: ${deleteResult.error.message}`,
        });
      }
      // On Postgres the failed DELETE aborted the fence's transaction, so the
      // upsert above is rolled back with it: those ids were NOT written. (On
      // an external engine they did land; reporting them anyway is harmless.)
      if (result.indexed > 0) {
        result.indexed = 0;
        recordUpsertFailure(
          result,
          "event",
          publishedEvents.map((e) => e.id),
          `rolled back with a failed removal: ${deleteResult.error.message}`,
        );
      }
    }
  }

  return result;
}

/**
 * Re-exported shape of the shared roll-up. The two indexing paths below used to
 * carry hand-copied aggregation loops; FR-004 collapsed them into
 * `summarizePricing`, which the browse listings and the single-event embed also
 * call — so the index and the surfaces it feeds can no longer drift.
 */
type EventPricingAggregate = FacePricingSummary;

const EMPTY_PRICING: EventPricingAggregate = {
  hasFreeTier: false,
  hasPayWhatYouWantTier: false,
  paidTierCount: 0,
  minPaidPriceCents: null,
};

/**
 * Roll each event's already-grouped tiers into the indexed pricing aggregate at
 * `indexedAt`. Thin wrapper so both indexing paths share one call and neither
 * can quietly reacquire its own loop.
 */
function summarizeTiersByEvent(
  tiersByEvent: ReadonlyMap<string, Parameters<typeof summarizePricing>[0]>,
  indexedAt: Date,
): Map<string, EventPricingAggregate> {
  const pricingByEvent = new Map<string, EventPricingAggregate>();
  for (const [eventId, tiers] of tiersByEvent) {
    pricingByEvent.set(eventId, summarizePricing(tiers, indexedAt));
  }
  return pricingByEvent;
}

/**
 * A category's name in every language, English first, for the event
 * document's searchable `categoryNames` (category-translations spec).
 */
export function categorySearchNames(category: {
  name: string;
  nameTranslations?: CategoryNameTranslations | null;
}): string[] {
  const names = categoryNames(category);
  return [...new Set([names.en, ...Object.values(names)])].filter(
    (n): n is string => typeof n === "string" && n.trim().length > 0,
  );
}

function eventToDocument(
  event: {
    id: string;
    slug?: string | null;
    orgId?: string | null;
    ownerType?: "ORG" | "HUMAN";
    ownerHumanId?: string | null;
    /** The owning human — with `orgId` + address, keys the event's circle. */
    humanId?: string | null;
    title: string;
    tags?: string[];
    /**
     * REQUIRED (N5): the public projection fails a missing gate closed
     * (label only, no `_geo`), so a caller that dropped it would silently
     * un-map the event rather than leak it — but it must be passed.
     */
    gateType: "NONE" | "PASSWORD" | "APPLICATION";
    placeId?: string | null;
    venueName?: string | null;
    addressText?: string | null;
    regionCode?: string | null;
    countryCode?: string | null;
    lat?: number | null;
    lng?: number | null;
    // FR-013: needed to coarsen the indexed coordinate/address for non-EXACT
    // events. Defaulted defensively below for callers without these fields.
    locationMode?: EventLocationMode | null;
    locationRadiusMeters?: number | null;
    locality?: string | null;
    region?: string | null;
    startsAt?: Date | null;
    endsAt?: Date | null;
    /** `Event.timezone`; unknown/absent falls back to the platform default. */
    timezone?: string | null;
    status: string;
    // Visibility drives the indexed `isPublic` flag. Defaulted defensively
    // below (absent/unknown → non-public) so a missing field never leaks a
    // non-public event as public.
    visibility?: EventVisibility | null;
    summary?: string | null;
    currency?: string | null;
  },
  popularityStats?: {
    ticketsSold: number;
    waitlistCount: number;
    totalCapacity: number;
  },
  imageUrl?: string | null,
  /** Category slug to include in searchable tags for category-based discovery. */
  categorySlug?: string | null,
  /** Aggregated pricing across ACTIVE ticket tiers for the event. */
  pricing: EventPricingAggregate = EMPTY_PRICING,
  /** Lowest buyer-facing all-in price in cents (null when no tiers exist). */
  lowestBuyerTotalCents?: number | null,
  /**
   * `isVenueConfirmed(event, place)`, resolved by the caller per batch (one
   * place read per distinct placeId — never per event). Defaults to false:
   * a caller that cannot say never leaks a `venueId`.
   */
  venueConfirmed: boolean = false,
  /**
   * THE CEILING, re-applied at index time: the venue's privacy row
   * (`VenueConfirmationResolution.placeLocation`, from the place read the
   * venue-confirmation batch already made — fails closed when that read
   * returned nothing). `save-event-shared` stores a withheld venue's public
   * projection on the event row, but an event published BEFORE its venue was
   * withheld still carries the house; re-flooring here pulls it down on the
   * next pass instead of waiting for someone to re-save it. Null = no venue.
   */
  placeLocation: PlaceLocationSource | null = null,
  /** The category's name in every language (`categorySearchNames`). */
  categoryNamesForSearch: string[] = [],
): EventSearchDocument {
  // Use underscore instead of colon to comply with Meilisearch ID requirements
  // (alphanumeric, hyphens, underscores only - no colons)

  // Calculate popularity score based on ticket sales and waitlist interest
  // Formula: (ticketsSold * 10) + (waitlistCount * 5) + fillRate bonus
  // Fill rate bonus: if capacity > 0 and > 50% sold, add up to 50 bonus points
  let popularityScore = 0;
  if (popularityStats) {
    const { ticketsSold, waitlistCount, totalCapacity } = popularityStats;
    popularityScore += ticketsSold * 10;
    popularityScore += waitlistCount * 5;

    // Fill rate bonus: up to 50 points if > 50% capacity sold
    if (totalCapacity > 0) {
      const fillRate = ticketsSold / totalCapacity;
      if (fillRate > 0.5) {
        popularityScore += Math.floor(Math.min(fillRate, 1) * 50);
      }
    }
  }

  // FR-013: never bake a non-EXACT event's precise pin or street address into
  // the public search index. THE public projection: the venue floors the
  // event, a withheld venue's events index the VENUE's keyed circle centre,
  // an event-level OBSCURED event its own keyed circle centre (`_geo` and
  // every geo filter then run on the EMITTED point), and a hidden one no
  // point at all. EXACT events index their true values unchanged. Fails
  // closed: a null/unknown mode is obscured (no `?? "EXACT"`).
  const publicLocation = projectPublicEventLocation(event, {
    place: placeLocation,
  });

  return {
    type: "event",
    id: `event_${event.id}`,
    eventId: event.id,
    slug: event.slug ?? null,
    orgId: event.orgId ?? null,
    ownerType: event.ownerType ?? "HUMAN",
    ownerHumanId: event.ownerHumanId ?? null,
    title: event.title,
    artists: [], // Would need to join with artists table
    tags: [
      ...(event.tags ?? []),
      // Include gate type as a searchable tag so search results surface it
      ...(event.gateType && event.gateType !== "NONE"
        ? [event.gateType.toLowerCase()]
        : []),
      // Include category slug so category-based discovery routes through Meilisearch
      ...(categorySlug ? [categorySlug] : []),
    ],
    // Searchable text, NOT a tag: a query in any of the category's languages
    // finds the event, and nothing filters on it.
    categoryNames: categoryNamesForSearch,
    // Venue-confirmation spec (docs/specs/2026-08-27): the place is named
    // on the public shape ONLY when the venue vouches for the event. An
    // unconfirmed third-party claim indexes as address-only — `venueId` null
    // — so a venue-filtered search never surfaces it as the venue's.
    venueId: venueConfirmed ? (event.placeId ?? null) : null,
    // The name: confirmed → as before. Unconfirmed → only the name-only
    // display (owner ruling 2026-10-06), which the caller passes in
    // `event.venueName` from `VenueConfirmationResolution.displayPlaceName`
    // (null unless `mayNameUnconfirmedVenue` granted it). Even then it is
    // indexed only when the public location is EXACT and not hidden — the
    // same branches where the event page names the venue — so naming the
    // venue never undoes an obscured or gated location.
    venueName: cardVenueName(
      event.venueName ?? null,
      venueConfirmed,
      publicLocation,
    ),
    addressText: publicLocation.label,
    // City comes from the event's locality (city-level, already exposed in the
    // coarse public address label — safe for OBSCURED events too). Events never
    // stored a city before; a later step aggregates city facets from this.
    city: publicLocation.locality,
    regionCode: event.regionCode ?? null,
    countryCode: event.countryCode ?? null,
    lat: publicLocation.lat,
    lng: publicLocation.lng,
    // How to DRAW that point: a pin only for EXACT, the projection's circle
    // otherwise. Both straight off the projection — never the row.
    locationIsExact: publicLocation.mode === "EXACT" && !publicLocation.hidden,
    locationRadiusMeters: publicLocation.radiusMeters,
    startsAt: event.startsAt ?? null,
    endsAt: event.endsAt ?? null,
    // The zone the adapters format the result's date in. Resolved here, so
    // the index never carries an id the formatter would reject.
    timezone: resolveTimeZone(event.timezone),
    status: event.status as "DRAFT" | "PUBLISHED" | "HIDDEN",
    // PUBLIC → true; PRIVATE (or any non-PUBLIC / unknown value) → false. The
    // event is STILL indexed regardless — this only stamps the flag so a later
    // step can gate embed/widget queries on it.
    isPublic: event.visibility === "PUBLIC",
    popularityScore,
    recencyScore: 0,
    summary: event.summary ?? null,
    imageUrl: imageUrl ?? null,
    // 0 when anyone can get in for nothing: a free tier, or a floor-0
    // pay-what-you-want tier. Price filters read this number; the LABEL tells
    // the two apart through the flags below.
    lowestPriceCents:
      pricing.hasFreeTier || pricing.hasPayWhatYouWantTier
        ? 0
        : pricing.minPaidPriceCents,
    lowestBuyerTotalCents: lowestBuyerTotalCents ?? null,
    currency: event.currency ?? null,
    paidTierCount: pricing.paidTierCount,
    hasFreeTier: pricing.hasFreeTier,
    hasPayWhatYouWantTier: pricing.hasPayWhatYouWantTier,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Human Indexing
// ─────────────────────────────────────────────────────────────────────────────

async function indexAllHumans(
  deps: BuildSearchIndexDeps,
  batchSize: number,
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  // OFFSET pagination: see the KNOWN GAP note in `indexAllEvents`.
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await deps.repos.humans.listForSearchIndex({
      limit: batchSize,
      offset,
    });

    if (page.items.length === 0) {
      hasMore = false;
      break;
    }

    const documents: MultiSearchDocument[] = [];

    for (const item of page.items) {
      try {
        documents.push(humanToDocument(item.human, item.page, item.identity));
      } catch (e) {
        result.errors.push({
          type: "human",
          id: item.human.id,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    if (documents.length > 0) {
      const indexResult = await deps.search.upsertDocuments({ documents });
      if (indexResult.ok) {
        result.indexed += indexResult.value.indexed;
      } else {
        deps.logger?.error("search.batch_index_failed", {
          type: "human",
          offset,
          error: indexResult.error.message,
        });
        // A page-level failure: recorded (the nightly's success goes false,
        // the type's stale-document sweep is skipped) and REPORTED.
        recordPageFailure(
          deps,
          result,
          "human",
          documents.flatMap((d) => (d.type === "human" ? [d.humanId] : [])),
          offset,
          indexResult.error,
        );
      }
    }

    hasMore = page.pageInfo.hasNextPage;
    offset = page.pageInfo.nextOffset ?? offset + batchSize;
  }

  return result;
}

async function indexHumansByIds(
  deps: BuildSearchIndexDeps,
  humanIds: string[],
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  const documents: MultiSearchDocument[] = [];
  // Upsert-or-REMOVE, like the event path: the incremental reindex is also
  // what the edit-triggered drain (`drainSearchReindexPending`) relies on to
  // take a human OUT of search, so an excluded human's document is deleted
  // here instead of lingering until the nightly rebuild.
  const docIdsToRemove: string[] = [];

  for (const humanId of humanIds) {
    try {
      const withIdentity = await deps.repos.humans.getByIdWithIdentity(humanId);
      const human = withIdentity?.human ?? null;
      const page =
        human && human.status === "ACTIVE"
          ? await deps.repos.entityPages.getByOwner("HUMAN", humanId)
          : null;
      // Same inclusion rule as the full reindex (`humans.listForSearchIndex`):
      // an ACTIVE human with a PUBLIC entity page. Anything else is removed.
      if (human && page && page.visibility === "PUBLIC") {
        documents.push(humanToDocument(human, page, withIdentity?.identity));
      } else {
        docIdsToRemove.push(`human_${humanId}`);
      }
    } catch (e) {
      result.errors.push({
        type: "human",
        id: humanId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  if (documents.length > 0) {
    const indexResult = await deps.search.upsertDocuments({ documents });
    if (indexResult.ok) {
      result.indexed = indexResult.value.indexed;
    } else {
      // Recorded, not dropped: the caller's partial-failure report fires and
      // the drain keeps the entity's pending mark.
      recordUpsertFailure(
        result,
        "human",
        documents.flatMap((d) => (d.type === "human" ? [d.humanId] : [])),
        indexResult.error.message,
      );
    }
  }

  await removeDocumentsOrRecord(deps, result, "human", docIdsToRemove);

  return result;
}

/**
 * Delete documents of entities that no longer belong in search, recording a
 * failed delete per id (so `reindexAfterMutation` reports it and the drain
 * keeps the entity's pending mark). Humans and organizations: their writes
 * are not fenced. Places call it inside their fence (see there).
 */
async function removeDocumentsOrRecord(
  deps: BuildSearchIndexDeps,
  result: IndexResult,
  type: "human" | "place" | "organization",
  docIds: string[],
): Promise<boolean> {
  if (docIds.length === 0) return true;
  const deleteResult = await deps.search.deleteDocuments({ ids: docIds });
  if (deleteResult.ok) return true;
  deps.logger?.error(`search.${type}_remove_failed`, {
    ids: docIds,
    error: deleteResult.error.message,
  });
  const prefix = `${type}_`;
  for (const docId of docIds) {
    result.errors.push({
      type,
      id: docId.startsWith(prefix) ? docId.slice(prefix.length) : docId,
      error: `remove_failed: ${deleteResult.error.message}`,
    });
  }
  return false;
}

function humanToDocument(
  human: {
    id: string;
    name?: string | null;
  },
  profile: {
    slug?: string | null;
    displayName?: string | null;
    bio?: string | null;
  },
  identity?: {
    /** Better Auth normalized handle (lowercase). */
    username?: string | null;
    /** Human-formatted handle as the user typed it. */
    displayUsername?: string | null;
  } | null,
): HumanSearchDocument {
  // Use underscore instead of colon to comply with Meilisearch ID requirements.
  // Username comes from AuthUser (Better Auth), not Human. We prefer the
  // display variant ("JaneSmith") for UI surfaces but keep both searchable
  // via subtitle so case-folded matches still hit.
  return {
    type: "human",
    id: `human_${human.id}`,
    humanId: human.id,
    username: identity?.displayUsername ?? identity?.username ?? null,
    displayName: profile.displayName ?? human.name ?? null,
    bio: profile.bio ?? null,
    profileSlug: profile.slug ?? null,
    eventsHostedCount: 0, // TODO: bulk-count via repo; popularity ranking uses 0 today
    isPublic: true, // Only indexing humans with entity pages, which default to PUBLIC
    // Humans intentionally have no city/region/country in the index — they
    // aren't location-anchored entities the way events and places are.
    city: null,
    regionCode: null,
    countryCode: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Place Indexing
// ─────────────────────────────────────────────────────────────────────────────

async function indexAllPlaces(
  deps: BuildSearchIndexDeps,
  batchSize: number,
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  // OFFSET pagination: see the KNOWN GAP note in `indexAllEvents`.
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await deps.repos.places.listForSearchIndex({
      limit: batchSize,
      offset,
    });

    if (page.items.length === 0) {
      hasMore = false;
      break;
    }

    // Build + write the page INSIDE the index-write fence (see
    // `withIndexWriteFence`), from place rows re-read under it.
    const pageIds = page.items.map((p) => p.id);
    let written: IndexResult;
    try {
      written = await withIndexWriteFence(
        deps,
        { eventIds: [], placeIds: pageIds },
        async (fenced) => {
          const rows = await Promise.all(
            pageIds.map((id) => fenced.repos.places.getById(id)),
          );
          return rows.filter(
            (row): row is NonNullable<typeof row> =>
              row !== null && row.status === "ACTIVE",
          );
        },
        () => null,
        async (fenced, items) => {
          const result: IndexResult = { indexed: 0, errors: [] };
          // Fetch entity pages for this batch in ONE bulk read — the bio (a search
          // signal) and the page SLUG (the only routable public identifier a place
          // has), plus the visibility that gates both. Places without a publishable
          // page get null for both.
          const pageMap = await fetchEntityPagesForOwners(
            fenced,
            "PLACE",
            items.map((p) => p.id),
          );

          const documents: MultiSearchDocument[] = [];

          for (const place of items) {
            try {
              const entityPage = pageMap.get(place.id) ?? null;
              documents.push(
                placeToDocument(
                  place,
                  // Bio rides the SAME gate as the link — see crawlablePageBio.
                  crawlablePageBio(entityPage),
                  // PUBLIC only — the same gate `humans.listForSearchIndex` already
                  // applies to human pages, and what the owner was promised when
                  // they picked UNLISTED ("it stays out of search and browse").
                  // A null slug degrades to `/places/id/{placeId}` at the client.
                  crawlablePageSlug(entityPage),
                ),
              );
            } catch (e) {
              result.errors.push({
                type: "place",
                id: place.id,
                error: e instanceof Error ? e.message : "Unknown error",
              });
            }
          }

          if (documents.length > 0) {
            const indexResult = await fenced.search.upsertDocuments({ documents });
            if (indexResult.ok) {
              result.indexed += indexResult.value.indexed;
            } else {
              fenced.logger?.error("search.batch_index_failed", {
                type: "place",
                offset,
                error: indexResult.error.message,
              });
              // Per-id errors — see the event page: a failed write (on
              // Postgres, an aborted fence transaction) is never a success.
              recordUpsertFailure(
                result,
                "place",
                items.map((p) => p.id),
                indexResult.error.message,
              );
            }
          }
          return result;
        },
      );
    } catch (err) {
      // Same isolation as the event pages: never let one page end the run.
      recordPageFailure(deps, result, "place", pageIds, offset, err);
      written = { indexed: 0, errors: [] };
    }
    result.indexed += written.indexed;
    result.errors.push(...written.errors);

    hasMore = page.pageInfo.hasNextPage;
    offset = page.pageInfo.nextOffset ?? offset + batchSize;
  }

  return result;
}

/**
 * Best-effort reporting: a MISSING or THROWING reporter must never change
 * indexing behaviour (ReporterPort convention, CLAUDE.md). Without the guard a
 * throwing `reportError` inside a `.catch` handler re-rejects and turns a
 * degraded document into a dropped one. Mirrors `safeReport` in run-batch.ts.
 */
function reportEntityPageFailure(
  deps: BuildSearchIndexDeps,
  err: unknown,
  ownerType: "ORGANIZATION" | "PLACE" | "HUMAN",
  owner: string | string[],
): void {
  try {
    const ownerIds = Array.isArray(owner) ? owner : [owner];
    deps.reportError?.(err, {
      tags: { useCase: "buildSearchIndex", step: "fetchEntityPage" },
      extra: {
        ownerType,
        ownerId: ownerIds[0] ?? null,
        ownerCount: ownerIds.length,
        // Bounded: a batch is up to 1000 owners and the whole list would
        // bloat every Sentry event for no extra diagnostic value.
        ownerIds: ownerIds.slice(0, 20),
      },
    });
  } catch {
    // Swallow — reporting is fire-and-forget.
  }
}

/** The slice of an EntityPage the indexer needs. */
type EntityPageForIndex = {
  bio: string | null;
  slug: string;
  visibility: PageVisibility;
};

/**
 * The page's bio, but ONLY when the page may be surfaced publicly.
 *
 * The bio is rendered as the search result's SUBTITLE, so indexing it for a
 * PRIVATE page publishes the description of a page nobody can open, and for an
 * UNLISTED one puts its content in exactly the "search and browse" its owner
 * opted out of. It rides the same gate as the link for that reason — they were
 * briefly split inside one call expression, which gated the slug and not the
 * bio three characters away.
 */
function crawlablePageBio(
  page: EntityPageForIndex | { bio: string | null; slug: string; visibility: PageVisibility } | null | undefined,
): string | null {
  return page && crawlablePageSlug(page) !== null ? (page.bio ?? null) : null;
}

/**
 * Bulk-fetch each owner's `EntityPage` for a set of owners. Returns a map
 * keyed by ownerId; owners without a page are simply absent. Used by the
 * org/place indexers to enrich documents with a searchable description AND —
 * for places — the page slug + visibility, which together decide the only
 * link `/places/[slug]` can resolve.
 *
 * ONE `getByOwners` call for the whole batch, not a `getByOwner` per owner: a
 * batch is up to 1000 owners, and fanning that out issued 1000 concurrent
 * `findUnique`s against the same index. The trade is that failure is now
 * per-BATCH rather than per-owner, which is the more useful Sentry signal
 * anyway — one alert saying the read is broken, not a thousand.
 */
async function fetchEntityPagesForOwners(
  deps: BuildSearchIndexDeps,
  ownerType: "ORGANIZATION" | "PLACE" | "HUMAN",
  ownerIds: string[],
): Promise<Map<string, EntityPageForIndex>> {
  const out = new Map<string, EntityPageForIndex>();
  if (ownerIds.length === 0) return out;
  try {
    const pages = await deps.repos.entityPages.getByOwners(
      ownerType,
      ownerIds,
    );
    for (const page of pages) {
      out.set(page.ownerId, {
        bio: page.bio ?? null,
        slug: page.slug,
        visibility: page.visibility,
      });
    }
  } catch (err) {
    // Deliberate swallow (ReporterPort convention, CLAUDE.md): a failed page
    // read must not abort a whole index batch — the owners just lose their
    // bios and, for places, their public link. That degradation is invisible
    // in the index, so it has to be visible in Sentry.
    reportEntityPageFailure(deps, err, ownerType, ownerIds);
  }
  return out;
}

async function indexPlacesByIds(
  deps: BuildSearchIndexDeps,
  placeIds: string[],
): Promise<IndexResult> {
  // A place's own id IS its fence key, so nothing can move out from under it.
  return withIndexWriteFence(
    deps,
    { eventIds: [], placeIds },
    async () => [],
    () => null,
    (fenced) => indexPlacesByIdsInFence(fenced, placeIds),
  );
}

async function indexPlacesByIdsInFence(
  deps: BuildSearchIndexDeps,
  placeIds: string[],
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  const documents: MultiSearchDocument[] = [];
  // Upsert-or-REMOVE (see `indexHumansByIds`): a place that is gone or no
  // longer ACTIVE — the full reindex's inclusion rule — is deleted here.
  const docIdsToRemove: string[] = [];

  for (const placeId of placeIds) {
    try {
      const place = await deps.repos.places.getById(placeId);
      if (!place || place.status !== "ACTIVE") {
        docIdsToRemove.push(`place_${placeId}`);
      } else {
        const page = await deps.repos.entityPages
          .getByOwner("PLACE", placeId)
          .catch((err: unknown) => {
            // Deliberate swallow (ReporterPort convention, CLAUDE.md): losing
            // the page costs this place its bio AND its public link (`pageSlug`
            // is what `/places/[slug]` resolves on), which is silent in the
            // index — so it must not be silent in Sentry.
            reportEntityPageFailure(deps, err, "PLACE", placeId);
            return null;
          });
        documents.push(
          // PUBLIC only, bio AND slug — see indexAllPlaces.
          placeToDocument(place, crawlablePageBio(page), crawlablePageSlug(page)),
        );
      }
    } catch (e) {
      result.errors.push({
        type: "place",
        id: placeId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  if (documents.length > 0) {
    const indexResult = await deps.search.upsertDocuments({ documents });
    if (indexResult.ok) {
      result.indexed = indexResult.value.indexed;
    } else {
      recordUpsertFailure(
        result,
        "place",
        documents.flatMap((d) => (d.type === "place" ? [d.placeId] : [])),
        indexResult.error.message,
      );
    }
  }

  const removed = await removeDocumentsOrRecord(
    deps,
    result,
    "place",
    docIdsToRemove,
  );
  // Inside the fence on Postgres a failed DELETE aborts the transaction, so
  // the upsert above rolls back with it (same as the event path).
  if (!removed && result.indexed > 0) {
    result.indexed = 0;
    recordUpsertFailure(
      result,
      "place",
      documents.flatMap((d) => (d.type === "place" ? [d.placeId] : [])),
      "rolled back with a failed removal",
    );
  }

  return result;
}

/**
 * Projects a place row into its search document.
 *
 * ADDRESS PRIVACY: the location goes through `redactPlaceLocation` BEFORE it
 * is written, never after. The index is queried anonymously, feeds several
 * autocompletes, and keeps documents until something reindexes them — so a
 * withheld address must never ENTER it. Filtering at query time would be one
 * forgotten call site away from publishing somebody's house.
 *
 * A withheld venue keeps `city`/`region`, so it stays findable by text; one
 * that publishes a circle also keeps the circle centre (and, for a circle
 * smaller than a cell, that centre's `geohash6`), so it stays findable by
 * proximity without being pinpointed. A fully hidden one publishes no position.
 */
function placeToDocument(
  place: {
    id: string;
    name: string;
    slug?: string | null;
    formattedAddress?: string | null;
    city?: string | null;
    region?: string | null;
    countryCode?: string | null;
    lat?: number | null;
    lng?: number | null;
    capacity?: number | null;
    status: string;
    verificationStatus: string;
    listedInDirectory: boolean;
    locationMode?: string | null;
    locationRadiusMeters?: number | null;
    locationLabel?: string | null;
  },
  bio: string | null = null,
  /**
   * The place's `EntityPage.slug` — the ONLY identifier `/places/[slug]` and
   * `/p/[slug]` resolve on, and a place's only slug at all. Null when the
   * place has no entity page; consumers must then fall back to
   * `/places/id/{placeId}`.
   */
  pageSlug: string | null = null,
): PlaceSearchDocument {
  const location = redactPlaceLocation(place);

  // Use underscore instead of colon to comply with Meilisearch ID requirements
  return {
    type: "place",
    id: `place_${place.id}`,
    placeId: place.id,
    name: place.name,
    pageSlug,
    formattedAddress: location.formattedAddress,
    city: location.city,
    region: location.region,
    countryCode: location.countryCode,
    lat: location.lat,
    lng: location.lng,
    geohash6: location.geohash6,
    locationIsExact: location.isExact,
    locationHidden: location.hidden,
    locationRadiusMeters: location.radiusMeters,
    areaLabel: location.areaLabel,
    capacity: place.capacity ?? null,
    eventCount: 0, // TODO: bulk-count via repo; popularity ranking uses 0 today
    bio,
    status: place.status as "ACTIVE" | "SUSPENDED" | "ARCHIVED",
    verificationStatus: place.verificationStatus as
      | "UNVERIFIED"
      | "VERIFIED"
      | "PENDING"
      | "REJECTED",
    listedInDirectory: place.listedInDirectory,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization Indexing
// ─────────────────────────────────────────────────────────────────────────────

async function indexAllOrganizations(
  deps: BuildSearchIndexDeps,
  batchSize: number,
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  // OFFSET pagination: see the KNOWN GAP note in `indexAllEvents`.
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const paginatedOrgs = await deps.repos.organizations.listActive({
      limit: batchSize,
      offset,
    });

    if (paginatedOrgs.items.length === 0) {
      hasMore = false;
      break;
    }

    const pageMap = await fetchEntityPagesForOwners(
      deps,
      "ORGANIZATION",
      paginatedOrgs.items.map((o) => o.id),
    );

    const documents: MultiSearchDocument[] = [];

    for (const org of paginatedOrgs.items) {
      try {
        // An org's bio is public search content too, and a PRIVATE org page
        // is just as unopenable as a PRIVATE venue one.
        documents.push(orgToDocument(org, crawlablePageBio(pageMap.get(org.id))));
      } catch (e) {
        result.errors.push({
          type: "organization",
          id: org.id,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    if (documents.length > 0) {
      const indexResult = await deps.search.upsertDocuments({ documents });
      if (indexResult.ok) {
        result.indexed += indexResult.value.indexed;
      } else {
        deps.logger?.error("search.batch_index_failed", {
          type: "organization",
          offset,
          error: indexResult.error.message,
        });
        recordPageFailure(
          deps,
          result,
          "organization",
          documents.flatMap((d) =>
            d.type === "organization" ? [d.orgId] : [],
          ),
          offset,
          indexResult.error,
        );
      }
    }

    offset += batchSize;
    hasMore = paginatedOrgs.items.length === batchSize;
  }

  return result;
}

async function indexOrganizationsByIds(
  deps: BuildSearchIndexDeps,
  orgIds: string[],
): Promise<IndexResult> {
  const result: IndexResult = { indexed: 0, errors: [] };
  const documents: MultiSearchDocument[] = [];
  // Upsert-or-REMOVE (see `indexHumansByIds`): same ACTIVE rule as
  // `organizations.listActive`, which the full reindex walks.
  const docIdsToRemove: string[] = [];

  for (const orgId of orgIds) {
    try {
      const org = await deps.repos.organizations.getById(orgId);
      if (!org || org.status !== "ACTIVE") {
        docIdsToRemove.push(`organization_${orgId}`);
      } else {
        // We need counts for individual orgs - do a simple query
        // In production this could be optimized with a dedicated method
        const page = await deps.repos.entityPages
          .getByOwner("ORGANIZATION", orgId)
          .catch((err: unknown) => {
            // Same deliberate swallow as the place path, and it was fully
            // silent before this change — no log, no report — so an org
            // losing its bio was invisible. CLAUDE.md's opportunistic
            // migration rule: fix it while editing this file.
            reportEntityPageFailure(deps, err, "ORGANIZATION", orgId);
            return null;
          });
        documents.push({
          type: "organization",
          id: `organization_${org.id}`,
          orgId: org.id,
          name: org.name,
          slug: org.slug,
          status: org.status,
          eventCount: 0, // Individual indexing doesn't have counts
          memberCount: 0,
          bio: crawlablePageBio(page),
        });
      }
    } catch (e) {
      result.errors.push({
        type: "organization",
        id: orgId,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }

  if (documents.length > 0) {
    const indexResult = await deps.search.upsertDocuments({ documents });
    if (indexResult.ok) {
      result.indexed = indexResult.value.indexed;
    } else {
      recordUpsertFailure(
        result,
        "organization",
        documents.flatMap((d) => (d.type === "organization" ? [d.orgId] : [])),
        indexResult.error.message,
      );
    }
  }

  await removeDocumentsOrRecord(deps, result, "organization", docIdsToRemove);

  return result;
}

function orgToDocument(
  org: {
    id: string;
    name: string;
    slug: string;
    status: string;
    eventCount: number;
    memberCount: number;
  },
  bio: string | null = null,
): OrganizationSearchDocument {
  // Use underscore instead of colon to comply with Meilisearch ID requirements
  return {
    type: "organization",
    id: `organization_${org.id}`,
    orgId: org.id,
    name: org.name,
    slug: org.slug,
    status: org.status as "ACTIVE" | "SUSPENDED" | "ARCHIVED",
    eventCount: org.eventCount,
    memberCount: org.memberCount,
    bio,
  };
}
