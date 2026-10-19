/**
 * A venue row (Place / SavedLocation) whose tax-rate cache is empty and should
 * be filled by a background provider lookup.
 */
export type TaxRateFillTarget =
  | { kind: "place"; placeId: string }
  | { kind: "saved-location"; savedLocationId: string };

/**
 * Queue a BACKGROUND tax-rate lookup for venue rows with no cached rate, so a
 * listing never has to call the tax provider inline (owner ruling 2026-10-06).
 * The job (`tax.fill-location-rate`) looks the rate up, fills the cache with
 * the same compare-and-set checkout uses, and re-indexes the venue's events,
 * so a card that said "See details" fills in.
 *
 * RIDES THE REPOS BAG, like the search-drain scheduling does: the composition
 * root attaches it as `repos.taxRateFills` (`withTaxRateFillQueue`,
 * packages/adapters), so every listing loader that is handed the repos can
 * reach it without each use case threading a new dependency. Absent (tests,
 * a root with no Cloud Tasks) = nothing is queued; the venue fills on its
 * next event-page view or checkout instead.
 *
 * Contract: deduplicates per venue (an implementation may drop a request for
 * a venue it queued recently), resolves once the requests are handed off,
 * and REJECTS on failure — the caller reports and carries on. Callers must
 * await it before their request finishes (Cloud Run starves work left
 * running after the response).
 */
export interface TaxRateFillQueuePort {
  request(targets: readonly TaxRateFillTarget[]): Promise<void>;
}
