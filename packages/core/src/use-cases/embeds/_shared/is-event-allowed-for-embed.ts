import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

/**
 * Hard cap on series sibling dates considered when authorizing an event-type
 * embed. Mirrors `MAX_PUBLIC_SERIES_DATES` in
 * `../../series/list-public-series-dates.ts` so embed authorization and the
 * public date switcher agree on what counts as a sellable sibling date.
 */
const MAX_PUBLIC_SERIES_DATES = 60;

export type AssertEventAllowedForEmbedDeps = {
  repos: Pick<Repos, "seriesOccurrences" | "events">;
};

type EmbedSubject = {
  subjectType: string;
  subjectId: string;
};

type EmbedEvent = {
  id: string;
  orgId: string | null;
};

/**
 * Authorizes the event for this embed or throws `event_not_found`. There is no
 * silent-allow path — unknown subject types are rejected.
 *
 * - Organization embeds: the event's `orgId` must match the embed subject.
 * - Event embeds: the event must either be the pinned event itself, or a
 *   PUBLISHED public sibling date of the series the pinned event belongs to
 *   that also shares the pinned event's org (defense-in-depth).
 * - Any other subject type fails closed.
 *
 * The caller is responsible for loading the event and verifying it is
 * PUBLISHED before invoking this helper.
 */
export async function assertEventAllowedForEmbed(
  deps: AssertEventAllowedForEmbedDeps,
  embed: EmbedSubject,
  event: EmbedEvent,
): Promise<void> {
  if (embed.subjectType === "organization") {
    if (event.orgId !== embed.subjectId) {
      throw fail("EVENT_NOT_FOUND");
    }
    return;
  }

  if (embed.subjectType === "event") {
    // Fast path: the pinned event itself.
    if (embed.subjectId === event.id) {
      return;
    }

    // Series relaxation: allow PUBLISHED public sibling dates of the series
    // the pinned event belongs to. Resolve the series from the PINNED event
    // (embed.subjectId), never the requested event.
    const series = await deps.repos.seriesOccurrences.findSeriesIdByEventId(
      embed.subjectId,
    );
    if (series) {
      const dates =
        await deps.repos.seriesOccurrences.listPublishedDatesBySeriesId(
          series.seriesId,
          MAX_PUBLIC_SERIES_DATES,
        );
      if (dates.some((d) => d.eventId === event.id)) {
        // Defense-in-depth: series are owner-scoped today, but never let the
        // auth boundary silently depend on that. Require the matched sibling to
        // share the pinned event's org. This extra read happens only on the
        // sibling path, not the pinned-event fast path.
        const pinnedEvent = await deps.repos.events.getById(embed.subjectId);
        if (
          pinnedEvent &&
          event.orgId != null &&
          pinnedEvent.orgId === event.orgId
        ) {
          return;
        }
        throw fail("EVENT_NOT_FOUND");
      }
    }

    throw fail("EVENT_NOT_FOUND");
  }

  // Fail closed: any unrecognized subject type (e.g. "place") is rejected.
  throw fail("EVENT_NOT_FOUND");
}
