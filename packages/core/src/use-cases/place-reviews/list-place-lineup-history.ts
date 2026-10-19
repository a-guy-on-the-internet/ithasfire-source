import { createHash } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ActAtPlaceRow } from "@th/types/repos/event-humans";

import { parseInput } from "../../lib/io";
import { venueConfirmedFilterFor } from "../../lib/venue-confirmation";

// ---------------------------------------------------------------------------
// listPlaceLineupHistory (venue-track-record-and-review-switch spec,
// docs/specs/2026-09-24, FR-013 / FR-016, ruling R7)
//
// Who has played a place — the recent line on the venue page and the full
// Roster on `/p/[slug]/acts`. Built ONLY from lineups the event pages already
// show: PUBLISHED-or-COMPLETED (R10) PUBLIC venue-confirmed ENDED events, role
// PERFORMER (the adapter's `listActsByPlace` gate). Public read, no actor.
//
// Grouping by act, distinct-show counting, ordering and the limit all live in
// the adapter's SQL (spec FU-006): the venue page asks for its recent line
// and gets that many acts plus a count, never the venue's whole credit
// history. This use case gates the place, maps acts to the public shape, and
// decides how many to ask for.
//
// No swallow lives here: an unknown or archived place is a typed error, the
// same way the sibling public place reads say it. The loader that embeds this
// on the page is the one that degrades (and reports) — NFR-003 is its job.
// ---------------------------------------------------------------------------

export const listPlaceLineupHistoryInputSchema = z
  .object({
    placeId: z.string().uuid(),
    /**
     * How many of the most recent acts to read. `null` = all of them (the
     * Roster page). The limit is applied IN SQL (spec FU-006), so with a
     * limit `all` is the same bounded prefix as `recent`; only
     * `allActsCount` still counts every act.
     */
    recentLimit: z.number().int().min(1).max(500).nullable(),
    /**
     * Override the clock — a show counts once its `endsAt <= now`. A TEST
     * SEAM for core and the loaders: the transport must not forward this
     * from the client (a caller-chosen `now` would reveal an in-progress
     * lineup, or hide history).
     */
    now: z.date().optional(),
  })
  .strict();

export const lineupHistoryActSchema = z
  .object({
    /**
     * Opaque, per-response-unique identity for the act — the React key. Two
     * acts may share a display name (a linked "Sam" without a public page and
     * an unlinked "Sam"), so name + profileUrl is NOT an identity. See
     * {@link actKeysFor}; never parse it.
     */
    key: z.string().min(1).max(300),
    name: z.string().min(1),
    /**
     * `/humans/{slug}` for a linked person with a PUBLIC profile page,
     * `/orgs/{slug}` for a group (lineup v3 FR-015) with a PUBLIC org page;
     * null otherwise.
     */
    profileUrl: z.string().nullable(),
    /** Distinct shows this act has played here. */
    timesPlayed: z.number().int().min(1),
    /** The most recent of those shows. */
    lastPlayedAt: z.date(),
  })
  .strict();

export const listPlaceLineupHistoryOutputSchema = z
  .object({
    /** The first `recentLimit` acts (every act when the limit is null). */
    recent: z.array(lineupHistoryActSchema),
    /**
     * The acts read, most recently played first: EVERY distinct act when
     * `recentLimit` is null (the Roster page), else equal to `recent`.
     */
    all: z.array(lineupHistoryActSchema),
    /** Every distinct act that has played here, regardless of the limit. */
    allActsCount: z.number().int().min(0),
  })
  .strict();

export type ListPlaceLineupHistoryInput = z.infer<
  typeof listPlaceLineupHistoryInputSchema
>;
export type LineupHistoryAct = z.infer<typeof lineupHistoryActSchema>;
export type ListPlaceLineupHistoryOutput = z.infer<
  typeof listPlaceLineupHistoryOutputSchema
>;

export type ListPlaceLineupHistoryDeps = {
  repos: Pick<Repos, "places" | "eventHumans">;
  clock: ClockPort;
  logger?: LoggerPort;
};

/**
 * The public human page route. `apps/web/src/app/humans/[slug]/page.tsx`
 * builds its canonical URL as `/humans/{page.slug}` and the search surfaces
 * link a `profileSlug` the same way — one scheme, not a new one. (The
 * `profileUrl` on `listPublicEventHumans` is the entry's external WEBSITE
 * and is null for every linked human, so it cannot be the link here.)
 */
export function humanProfileUrlFor(profileSlug: string | null): string | null {
  const slug = profileSlug?.trim();
  return slug ? `/humans/${slug}` : null;
}

/**
 * The public org page route (`apps/web/src/app/orgs/[slug]`) — the same
 * scheme the bill links a group with (`bill-items.ts` `orgPageUrlFor`; not
 * imported, because that module imports this one). `orgPageSlug` is only
 * ever a PUBLIC page's slug (`ActAtPlaceRow`).
 */
function orgProfileUrlFor(orgPageSlug: string | null | undefined): string | null {
  const slug = orgPageSlug?.trim();
  return slug ? `/orgs/${slug}` : null;
}

/** The whitespace set the adapter's SQL `btrim`s (not JS `trim`'s wider set). */
const ACT_KEY_EDGE_WS = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
/** Hex chars of the SHA-256 kept for a linked act's key (48 bits). */
const ACT_KEY_HASH_CHARS = 12;
/** Stage names are free text; bound the key so a pathological one can't bloat it. */
const ACT_KEY_NAME_MAX = 200;

/**
 * One opaque key per act, mirroring the key the adapter's SQL groups on:
 *   · linked   → `h:` + the first 12 hex chars of SHA-256(placeId + ":" +
 *                humanId). The raw id of a human with no public page never
 *                leaves core. The PLACE is in the hash on purpose: keyed on the
 *                human alone, the same key would appear on every venue page
 *                that human played, letting anyone join a private-profile
 *                performer's history ACROSS venues (R7 accepts the pattern at
 *                ONE place, not across places). Stable per venue, unlinkable
 *                between venues.
 *   · group    → `o:` + the same hash over (placeId + ":" + orgId) (lineup v3
 *                FR-015) — a group is its own act, keyed like a person and
 *                for the same reason: never its raw id.
 *   · unlinked → `n:` + the stage name trimmed of the SQL's whitespace set
 *                and lower-cased (the SQL's `lower(btrim(externalName))`).
 * JS `toLowerCase` and Postgres `lower` can disagree on exotic code points,
 * and a hash prefix can in principle collide, so uniqueness is ENFORCED, not
 * assumed: a repeat within one response gets `#2`, `#3`… in list order. The
 * key is an identity for rendering only — never parse it.
 */
function actKeysFor(
  placeId: string,
  acts: ReadonlyArray<ActAtPlaceRow>,
): string[] {
  const seen = new Map<string, number>();
  return acts.map((act) => {
    const base = act.humanId
      ? `h:${createHash("sha256")
          .update(`${placeId}:${act.humanId}`)
          .digest("hex")
          .slice(0, ACT_KEY_HASH_CHARS)}`
      : act.orgId
        ? `o:${createHash("sha256")
            .update(`${placeId}:${act.orgId}`)
            .digest("hex")
            .slice(0, ACT_KEY_HASH_CHARS)}`
        : `n:${(act.externalName ?? act.name)
          .replace(ACT_KEY_EDGE_WS, "")
          .toLowerCase()
          .slice(0, ACT_KEY_NAME_MAX)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

export async function listPlaceLineupHistory(
  deps: ListPlaceLineupHistoryDeps,
  rawInput: unknown,
): Promise<ListPlaceLineupHistoryOutput> {
  const input = parseInput(listPlaceLineupHistoryInputSchema, rawInput);
  const now = input.now ?? deps.clock.now();

  const place = await deps.repos.places.getById(input.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }
  // Public gating, as `getPlacePublic`: an archived place has no public
  // history to show.
  if (place.status === "ARCHIVED") {
    throw fail("PLACE_ARCHIVED");
  }

  // The same confirmation predicate `recalculatePlaceStats` reads through —
  // an unconfirmed third-party event's lineup is not this venue's history.
  // `recentLimit` is pushed into the query: the page's recent line is the
  // only thing it renders besides the count, so a venue with years of
  // history costs `recentLimit` rows, not all of them.
  const page = await deps.repos.eventHumans.listActsByPlace({
    placeId: input.placeId,
    now,
    venueConfirmedFor: venueConfirmedFilterFor(place),
    limit: input.recentLimit,
  });

  const keys = actKeysFor(input.placeId, page.acts);
  const acts: LineupHistoryAct[] = page.acts.map((act, i) => ({
    key: keys[i]!,
    name: act.name,
    profileUrl: act.orgId
      ? orgProfileUrlFor(act.orgPageSlug)
      : humanProfileUrlFor(act.profileSlug),
    timesPlayed: act.timesPlayed,
    lastPlayedAt: act.lastPlayedAt,
  }));

  // `all` is what was read: EVERY act when `recentLimit` is null (the acts
  // page), otherwise the same bounded prefix as `recent` — the page render
  // reads only `recent` and `allActsCount`, so it must not pay for the rest.
  return listPlaceLineupHistoryOutputSchema.parse({
    recent: acts,
    all: acts,
    allActsCount: page.totalActs,
  });
}
