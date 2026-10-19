import type { Repos } from "@th/ports/repos";

/**
 * How far ahead a consent change's reindex looks, and how many listings it
 * will pull in one page. Both are HARD bounds — this runs unattended after a
 * toggle or a review decision and must never turn into a full-table walk of
 * a busy venue.
 *
 * `listPublishedByPlace` clamps `limit` to 100 in the adapter, so 100 is "one
 * page, the most the repo will give". Because the stewardship filter now rides
 * in the WHERE, those 100 are 100 COMMUNITY listings and not 100 events of
 * which a handful are listings. The window is a little over a year because a
 * recurring listing pins `Event.startsAt` to its next upcoming night; anything
 * beyond either bound is left to the nightly `search.full-reindex`.
 */
export const COMMUNITY_LISTING_REINDEX_LIMIT = 100;
const REINDEX_HORIZON_DAYS = 400;

/**
 * The COMMUNITY listings at a place whose search documents a change to
 * `Place.acceptsCommunityListings` makes stale: `buildSearchIndex` stamps
 * the venue confirmation that consent drives into each listing's event
 * document. Callers mark the returned ids (`markForSearchReindex`) in the
 * SAME transaction as the consent write. Used by the owner switch
 * (`setPlaceCommunityListingAcceptance`, whose doc covers scope and bounds)
 * and the FR-006 consent reset in `reviewPlaceVerification`.
 */
export function listCommunityListingsToReindex(
  events: Pick<Repos["events"], "listPublishedByPlace">,
  placeId: string,
  now: Date,
): Promise<string[]> {
  return events
    .listPublishedByPlace({
      placeId,
      from: now,
      to: new Date(now.getTime() + REINDEX_HORIZON_DAYS * 24 * 60 * 60 * 1000),
      status: "upcoming",
      limit: COMMUNITY_LISTING_REINDEX_LIMIT,
      // The budget must buy LISTINGS. See the doc above: in the WHERE, above
      // the take.
      stewardship: "COMMUNITY",
      // A withdrawn listing's document is identical before and after the flip.
      excludeVenueConfirmationWithdrawn: true,
      // A recurring listing pins `startsAt` to its next night, which can be
      // stale; without this its later nights would not bring it back.
      includeDateOccurrences: true,
      // Deliberately NO `venueConfirmedFor`: on a RETRACTION the listings we
      // need to re-index are precisely the ones that just stopped being
      // confirmed, and a confirmed-only filter would return none of them.
    })
    .then((page) => page.items.map((item) => item.id));
}
