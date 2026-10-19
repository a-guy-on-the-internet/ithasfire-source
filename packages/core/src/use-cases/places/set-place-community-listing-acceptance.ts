import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import { describeError, parseInput } from "../../lib/io";
import { runReindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import { fail } from "@th/errors";
import {
  COMMUNITY_LISTING_REINDEX_LIMIT,
  listCommunityListingsToReindex,
} from "./_shared/community-listings-to-reindex";
import { requirePlaceSwitchAuthority } from "./_shared/place-switch-authority";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const setPlaceCommunityListingAcceptanceInputSchema = z
  .object({
    placeId: z.string().uuid(),
    actorHumanId: z.string().uuid(),
    accepts: z.boolean(),
  })
  .strict();

export const setPlaceCommunityListingAcceptanceOutputSchema = z
  .object({
    placeId: z.string().uuid(),
    acceptsCommunityListings: z.boolean(),
  })
  .strict();

export type SetPlaceCommunityListingAcceptanceInput = z.infer<
  typeof setPlaceCommunityListingAcceptanceInputSchema
>;
export type SetPlaceCommunityListingAcceptanceOutput = z.infer<
  typeof setPlaceCommunityListingAcceptanceOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type SetPlaceCommunityListingAcceptanceDeps = {
  /**
   * Widened from `Pick` (same reason as `togglePlaceDirectoryListing`): the
   * post-commit reindex hands `deps.repos` to `buildSearchIndex`, which reads
   * far more than this use case's own three repos.
   */
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Best-effort incremental search reindex of the place's COMMUNITY listings
   * after a REAL flip. Absent = no immediate reindex; the listings are still
   * MARKED in the flip's transaction (`SearchReindexPending`), so the
   * scheduled drain or the nightly full reindex refreshes them.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort reporter, forwarded into that reindex AND wrapped around the
   * enumeration. Both are fire-and-forget, so a failure reaches no tRPC or
   * fastify backstop and `logger.warn` is not captured by Sentry — without
   * this, search silently keeps asserting a venue's backing for up to ~18h
   * after it was retracted, with nothing anywhere.
   */
  reportError?: ReporterPort;
};

/**
 * How many single-event index passes may be in flight at once.
 *
 * Each pass costs ~8-10 queries plus an index write, and this runs in the
 * background against the SAME Prisma pool the request path uses — dispatching
 * a full page at once is ~1000 concurrent queries and turns one owner's toggle
 * into `P2024` pool timeouts for live traffic. Four keeps the peak near ~40
 * in-flight queries, comfortably inside a default pool (`num_cpus * 2 + 1`),
 * while still draining a full 100-listing page in ~25 rounds of work nobody is
 * waiting on. Raise it only with a pool size in hand.
 */
const REINDEX_CONCURRENCY = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue-owner-only flip of `Place.acceptsCommunityListings`
 * (community-listings-at-claimed-venues FR-001). Deliberately shaped as a twin
 * of `setPlaceBookingAcceptance` — same ownership check, same idempotent
 * write-then-audit, same failures — because a venue owner meets the two
 * toggles side by side and a difference in behaviour between them would be
 * arbitrary.
 *
 * Ownership: a direct human owner of the place, or an OWNER/ADMIN of an owning
 * org. Deliberately NARROWER than the READ that renders this toggle —
 * `getPlaceForEdit` admits ANY org membership, VIEWER/SCANNER/FINANCE included
 * — because seeing the venue's settings is not the same as granting consent on
 * the venue's behalf.
 *
 * WHAT THE FLAG DOES, so the copy above it can be honest: it is the third arm
 * of `isVenueConfirmed` (packages/core/src/lib/venue-confirmation.ts), read
 * LIVE. Nothing is stamped. Turning it on retroactively confirms every
 * ownerless COMMUNITY listing already attached to the place; turning it off
 * retracts them to address-only. And because confirmation drives availability
 * and conflict detection too, an accepted weekly open mic BLOCKS that slot for
 * booking requests. That last one is the spec's ruling, not a side effect:
 * the room genuinely is busy.
 *
 * VERIFICATION GATE — enabling requires a VERIFIED place, the same gate
 * `setPlaceBookingAcceptance` applies. Two reasons, and they are stronger here
 * than there:
 *   · this is a CONSENT, and the spec's `revocation_reverts_to_address_only`
 *     ruling says unowned consent is the exact state the model exists to
 *     prevent. An UNVERIFIED place has at most a provisional claimant, i.e.
 *     nobody whose consent means anything yet;
 *   · the flag makes an ownerless listing speak for the venue on the public
 *     page and in search. Letting an unverified claimant grant that would
 *     hand a venue's identity to whoever filed the claim first.
 * Turning it OFF is never gated — retracting consent must always be possible,
 * including on a place that has since lost its verification.
 *
 * SEARCH is the one surface where the flag is NOT read live: `buildSearchIndex`
 * resolves `isVenueConfirmed` per event and STAMPS the answer into the
 * document. So a REAL transition (never an idempotent re-flip) schedules a
 * bounded, best-effort reindex of the place's COMMUNITY listings after the
 * write — see {@link reindexPlaceCommunityListings}. Without it, search went
 * on asserting a venue's backing for up to ~18h after it was retracted,
 * because the only thing that recomputed the stamp was the 03:00 UTC
 * `search.full-reindex`.
 */
export async function setPlaceCommunityListingAcceptance(
  deps: SetPlaceCommunityListingAcceptanceDeps,
  rawInput: unknown,
): Promise<SetPlaceCommunityListingAcceptanceOutput> {
  const input = parseInput(
    setPlaceCommunityListingAcceptanceInputSchema,
    rawInput,
  );

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Ownership check: actor must be a direct human owner, or hold OWNER/ADMIN
  // in an owning org.
  //
  // WHY ORG_ADMIN_ROLES and not "any membership": this flag speaks FOR the
  // venue — it grants standing consent, retroactively confirms every ownerless
  // COMMUNITY listing at the place, and those confirmed nights then block the
  // venue's own booking availability. That is a decision about what the
  // business agrees to, not content work, so it sits at the same bar as org
  // settings. A SCANNER on the door, a VIEWER, a FINANCE role and even an
  // EDITOR are all deliberately excluded.
  //
  // The predicate is shared with its two sibling switches AND with the
  // `viewerCanManageSwitches` capability `getPlaceForEdit` publishes — see
  // `_shared/place-switch-authority`.
  await requirePlaceSwitchAuthority(deps, place, input.actorHumanId);

  if (input.accepts && place.verificationStatus !== "VERIFIED") {
    throw fail("PLACE_NOT_VERIFIED");
  }

  const now = deps.clock.now();

  // One transaction: the flip, its audit row and the search marks for the
  // listings whose stamped confirmation it moves (see
  // `reindexPlaceCommunityListings`), so the refresh cannot be lost after
  // the flip commits.
  //
  // The flip writes `acceptsCommunityListings` and nothing else, as a
  // compare-and-set. It used to rebuild the whole row through
  // `places.upsert` from the read above, which undid a moderator's
  // concurrent name/address edit, wrote a NULL street line or country back
  // as "", and re-sent the read's phone and website over any newer edit
  // (websiteSource was never sent, so it was preserved; it still is). An
  // enable also requires the row to be VERIFIED at write time, so a place
  // that lost its verification since the check above is refused, not
  // consented.
  const { changed, listingIds } = await deps.repos.tx(async (tx) => {
    const result = await tx.places.setCommunityListingAcceptance({
      placeId: place.id,
      accepts: input.accepts,
      requireVerified: input.accepts,
    });
    if (!result.changed) {
      // Already in the desired state (idempotent: still audited, so the
      // trail captures the owner's intent), or the write's conditions failed.
      const current = await tx.places.getById(place.id);
      if (!current) {
        throw fail("PLACE_NOT_FOUND");
      }
      if (current.acceptsCommunityListings !== input.accepts) {
        if (input.accepts && current.verificationStatus !== "VERIFIED") {
          throw fail("PLACE_NOT_VERIFIED");
        }
        throw fail("CONFLICT", {
          meta: {
            reason: "place_community_listing_acceptance_changed",
            placeId: place.id,
          },
        });
      }
    }

    await tx.audit.log({
      entity: "place",
      entityId: place.id,
      action: input.accepts
        ? "place.community_listing_acceptance_enabled"
        : "place.community_listing_acceptance_disabled",
      data: {
        // From what the write did, not the earlier read.
        previous: result.changed ? !input.accepts : input.accepts,
        next: input.accepts,
        actorHumanId: input.actorHumanId,
      },
      at: now,
    });

    // ONLY on a real transition: an idempotent re-flip changed nothing.
    if (!result.changed) return { changed: false, listingIds: [] };
    const ids = await listCommunityListingsToReindex(tx.events, place.id, now);
    await markForSearchReindex(
      tx,
      ids.map((id) => ({ kind: "event" as const, id })),
      now,
    );
    return { changed: true, listingIds: ids };
  });

  deps.logger?.info("places.set_community_listing_acceptance", {
    placeId: place.id,
    actorHumanId: input.actorHumanId,
    acceptsCommunityListings: input.accepts,
  });

  // AFTER the write, and ONLY on a real transition. An idempotent re-flip
  // changed nothing, so re-indexing would be pure load; and indexing before
  // the write lands would publish a confirmation state that might not exist.
  if (changed) {
    reindexPlaceCommunityListings(deps, place.id, listingIds);
  }

  return setPlaceCommunityListingAcceptanceOutputSchema.parse({
    placeId: place.id,
    acceptsCommunityListings: input.accepts,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-flip search reindex
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Push the place's COMMUNITY listings back through the incremental search
 * index after consent flips.
 *
 * WHY THIS EXISTS: `acceptsCommunityListings` is the third arm of
 * `isVenueConfirmed` (`packages/core/src/lib/venue-confirmation.ts`), which
 * `buildSearchIndex` resolves per event via `resolveVenueConfirmationByEvent`.
 * The flag is read LIVE on the page but is STAMPED into the search document at
 * index time, and nothing recomputed it except the nightly
 * `search.full-reindex` (`0 3 * * *` UTC). So a venue that retracted consent
 * at 09:00 kept having search assert its backing for the rest of the day.
 *
 * TWO HALVES. The ENUMERATION runs inside the flip's transaction and the
 * listings it returns are MARKED there (`SearchReindexPending`), so the
 * refresh commits with the flip; a failing read fails the flip, which is a
 * database read on the database the flip just wrote. The REINDEX is
 * fire-and-forget, and it has to be: the owner's toggle must not wait on (or
 * fail because of) a search backend —
 *  - no `search` port: no immediate pass; the marks wait for the drain;
 *  - the index write blowing up: swallowed and reported inside
 *    `reindexAfterMutation`, and the listing's mark stays for the drain.
 *
 * SCOPE — COMMUNITY listings only, filtered IN SQL. An OWNED event at this
 * venue takes its confirmation from the owner arm or an explicit stamp;
 * consent never moved it, so re-indexing it would be load with no output
 * change. The filter has to be in the query rather than on the page: `limit`
 * is a SQL `take`, so filtering afterwards would spend the budget on the
 * soonest 100 events at the venue — overwhelmingly OWNED at a room that
 * programmes itself five nights a week — and the listings past that prefix
 * would silently keep their stale confirmation until 03:00 UTC.
 *
 * WITHDRAWN LISTINGS ARE EXCLUDED, for the same "spend the budget on rows
 * that can actually move" reason rather than for safety. FR-003 makes
 * withdrawal negate the community arm, so a withdrawn listing is unconfirmed
 * before AND after this flip — its document is byte-identical either way.
 * Skipping it can never miss a change, and it stops a venue that has rejected
 * a run of bad listings from crowding the live ones out of the page. It is
 * also the exact predicate pair `countCommunityListingsAtPlace` uses for the
 * number the owner was shown before flipping, so the set we act on is the set
 * they were told about.
 *
 * BOUNDS — one `listPublishedByPlace` page (`take` ≤ 100 in SQL) over a
 * ~400-day window, soonest first, and now ≤ 100 actual LISTINGS rather than
 * whatever listings happened to fall inside the first 100 events. The tail
 * beyond that is left to the nightly reconcile; the alternative is an
 * unbounded walk off the back of a toggle click. `listAllByPlace` is the other
 * place-scoped enumerator and was rejected for exactly this: it takes no
 * `limit`, so its row count is whatever the window happens to hold.
 *
 * FAN-OUT IS PACED, not dispatched at once. Each single-event index pass is
 * ~8-10 queries (`getById`, the popularity aggregate, image refs, moderation,
 * ticket types, place, category, pricing) plus an index write, so 100 at once
 * is ~1000 concurrent queries on the same Prisma pool that serves live
 * requests — a `P2024` pool timeout in the request path, caused by a
 * background toggle. Instead we await completion in chunks of
 * {@link REINDEX_CONCURRENCY}: at ~4 passes in flight the peak is ~40
 * in-flight queries, which sits under a default pool (`num_cpus * 2 + 1`) with
 * headroom to spare, and 100 listings drain in ~25 rounds of background work
 * the caller never sees. `runReindexAfterMutation` is the SAME helper
 * `reindexAfterMutation` wraps — it just hands back the promise, because
 * completion is the only thing that can actually apply back-pressure. Reaching
 * past it to a batched `buildSearchIndex` would fork this path off the shared
 * swallow/report discipline, which is how that reporter went dead once before.
 *
 * The enumeration is `listCommunityListingsToReindex`
 * (`_shared/community-listings-to-reindex.ts`), shared with the FR-006 consent
 * reset in `reviewPlaceVerification`.
 */

/**
 * The fire-and-forget fan-out over the listings the flip's transaction
 * enumerated and marked ({@link listCommunityListingsToReindex}). Each successful pass
 * clears its listing's mark; anything left is the drain's.
 */
function reindexPlaceCommunityListings(
  deps: SetPlaceCommunityListingAcceptanceDeps,
  placeId: string,
  listingIds: string[],
): void {
  if (!deps.search || listingIds.length === 0) return;

  void (async () => {
    const page = { items: listingIds.map((id) => ({ id })) };

    const reindexDeps = {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    };

    // Rejections collected across ALL chunks, rethrown once at the end.
    //
    // `allSettled`, not `all`: one listing's index failure must never abandon
    // the rest of the page. `runReindexAfterMutation` does not reject today
    // (it is `reindexAfterMutation`'s own body, which reports and swallows
    // internally), so `all` would behave identically — but that makes the
    // property a CONTRACT of a shared helper this file does not own, and a
    // future edit there would drop every remaining chunk.
    //
    // `allSettled` ALONE would be worse than `all`, though: it swallows the
    // rejection outright, so a broken contract would go to Sentry not at all
    // rather than once. Hence the collect-and-rethrow — the tail still runs,
    // AND the terminal catch below still reports.
    const failures: unknown[] = [];

    for (let i = 0; i < page.items.length; i += REINDEX_CONCURRENCY) {
      const settled = await Promise.allSettled(
        page.items
          .slice(i, i + REINDEX_CONCURRENCY)
          .map((listing) =>
            runReindexAfterMutation(
              reindexDeps,
              "setPlaceCommunityListingAcceptance",
              { kind: "event", id: listing.id },
            ),
          ),
      );

      for (const outcome of settled) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
    }

    deps.logger?.info(
      "setPlaceCommunityListingAcceptance.community_listings_reindexed",
      {
        placeId,
        reindexed: page.items.length - failures.length,
        failed: failures.length,
        // The page is capped: a full one means there may be listings this run
        // did not reach, and the nightly reconcile owns them.
        truncated: page.items.length >= COMMUNITY_LISTING_REINDEX_LIMIT,
      },
    );

    // Every chunk has run by now, so rethrowing abandons nothing. The terminal
    // catch below turns this into exactly one `logger.error` + `reportError`,
    // rather than one per failed listing.
    if (failures.length > 0) throw failures[0];
  })().catch((err: unknown) => {
    // A listing's index pass rejected (the enumeration now runs inside the
    // flip's transaction). `logger.warn` is not captured by Sentry and this
    // has no backstop above it, so: error + report. Its mark stays for the
    // drain.
    deps.logger?.error(
      "setPlaceCommunityListingAcceptance.community_listing_reindex_failed",
      { placeId, error: describeError(err) },
    );
    try {
      deps.reportError?.(err, {
        tags: {
          useCase: "setPlaceCommunityListingAcceptance",
          op: "reindexPlaceCommunityListings",
        },
        extra: { placeId },
      });
    } catch {
      // A throwing reporter must never turn this graceful swallow into an
      // unhandled rejection.
    }
  });
}
