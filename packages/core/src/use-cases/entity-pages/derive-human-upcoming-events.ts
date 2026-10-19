import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { HumanPerformanceSummary } from "@th/types/repos/event-humans";

import { PUBLIC_LINEUP_ROLES } from "../../lib/event-human-roles";
import { resolveVenueConfirmedByEvent } from "../../lib/venue-confirmation";
import { toHumanShowSummary } from "../event-humans/list-human-shows";

/**
 * Cap on how many derived events a HUMAN `upcoming_events` block carries.
 * Mirrors DERIVED_UPCOMING_EVENTS_LIMIT for the PLACE/ORG derivations in
 * get-public-page so all three owner types surface the same list size.
 */
export const DERIVED_HUMAN_UPCOMING_EVENTS_LIMIT = 8;

/** Matches the event-item shape the PLACE/ORG `upcoming_events` derivations emit. */
export type HumanUpcomingEventItem = {
  id: string;
  title: string;
  /** ISO timestamp. */
  date: string;
  venueName?: string;
  slug?: string;
};

export type LoadHumanUpcomingEventItemsDeps = {
  repos: Pick<Repos, "eventHumans" | "places">;
  /** Deliberate-swallow reporter for the batched place read (see lib). */
  reportError?: ReporterPort;
};

/**
 * PUBLIC venue label for a performance (venue-confirmation spec, security
 * review M1): the venue is NAMED only when it vouches for the event —
 * venue-owned, or stamped and not withdrawn for the place the event is at
 * (`isVenueConfirmed`, THE derivation). Otherwise the coarse location label
 * (the address-only posture), else nothing. The raw `venueName` the adapter
 * still carries is for the OWNER-facing `list-human-shows`, never here.
 */
export function publicVenueNameFor(
  performance: Pick<HumanPerformanceSummary, "placeName" | "locationLabel">,
  venueConfirmed: boolean,
): string | undefined {
  if (venueConfirmed && performance.placeName) return performance.placeName;
  return performance.locationLabel ?? undefined;
}

/**
 * Derives `upcoming_events` items for a HUMAN page from the human's real
 * upcoming public-lineup credits — the SAME repo path
 * (`listPerformancesByHuman`, PUBLIC_LINEUP_ROLES, published/public-visibility
 * filtering in the repo) the `shows` block derivation uses, so the two can
 * never drift on drafts, unpublished events, or lineup removals.
 *
 * Returns null when the human has ZERO upcoming performances so callers leave
 * the block's stored static data untouched (an owner-curated static list must
 * not be wiped to empty). Shared by get-public-page AND get-my-page so the
 * public page and the editor preview stay consistent, the way `shows` already
 * is.
 */
export async function loadHumanUpcomingEventItems(
  deps: LoadHumanUpcomingEventItemsDeps,
  humanId: string,
): Promise<HumanUpcomingEventItem[] | null> {
  const performances = await deps.repos.eventHumans.listPerformancesByHuman({
    humanId,
    roles: PUBLIC_LINEUP_ROLES,
    when: "upcoming",
    now: new Date(),
  });
  if (performances.length === 0) return null;

  const page = performances.slice(0, DERIVED_HUMAN_UPCOMING_EVENTS_LIMIT);
  // One place read per distinct venue on the page, never per event.
  const confirmedByEvent = await resolveVenueConfirmedByEvent(
    deps,
    page.map((p) => ({ ...p, id: p.eventId })),
    { useCase: "loadHumanUpcomingEventItems" },
  );

  return page.map((performance) => {
    const show = toHumanShowSummary(performance);
    const venueName = publicVenueNameFor(
      performance,
      confirmedByEvent.get(performance.eventId) === true,
    );
    return {
      id: show.id,
      title: show.title,
      date: show.date,
      // The upcoming_events item shape OMITS venueName when unknown (the
      // PLACE/ORG derivations never emit null).
      ...(venueName ? { venueName } : {}),
      ...(show.slug ? { slug: show.slug } : {}),
    };
  });
}
