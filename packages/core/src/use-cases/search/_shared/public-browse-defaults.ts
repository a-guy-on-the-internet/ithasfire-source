import type { MultiSearchQueryPort } from "@th/ports/search/multi-index.port";

type BrowseFilters = NonNullable<
  Parameters<MultiSearchQueryPort["autocomplete"]>[0]["filters"]
>;

/**
 * The shared filter floor for PUBLIC event-browse surfaces (home rails, nearby,
 * category, "featured"). Every empty-query browse use case starts from here and
 * then layers on its own geo / tags / regionCodes.
 *
 * Centralizes the "published + public + upcoming-only" browse contract so a
 * change to the floor (e.g. adding an upper date bound, or a directory gate)
 * lands in ONE place instead of being copy-pasted across each caller. The
 * PUBLIC/visibility gate itself is enforced adapter-side; this only carries the
 * `publishedOnly` + `now` date floor those surfaces all share.
 *
 * Returns a FRESH object each call (with a fresh `now`), safe to spread + mutate.
 */
export function publicBrowseEventDefaults(): BrowseFilters {
  return {
    types: ["event"],
    publishedOnly: true,
    dateRange: { from: new Date().toISOString() },
  };
}
