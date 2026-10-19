import type { LoggerPort } from "@th/ports/logger";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { SavedLocationsRepo } from "@th/ports/repos/saved-locations";
import { safeReporter, type ReporterPort } from "@th/ports/reporter";
import type {
  TaxRateFillQueuePort,
  TaxRateFillTarget,
} from "@th/ports/tax-rate-fill-queue";
import type { EventRecord, EventTicketTypeSummary } from "@th/types";

import { isTicketTypeOnSale } from "../../../lib/orders/door-pricing";
import { resolveListingPriceCents } from "../../../lib/pricing/pay-what-you-want";
import { resolveTaxImpositions } from "../../../lib/pricing/tax-impositions";
import {
  computeBuyerTicketPricing,
  resolveBuyerFeeContexts,
  type BuyerFeeContextBatchRepos,
} from "./estimate-buyer-ticket-pricing";
import {
  eventTaxRateLocationRef,
  resolveEventTaxSitusBatch,
  type TaxRateLocationReader,
} from "./resolve-event-tax-rate";
import { resolveQuoteTaxRate } from "./resolve-quote-tax-rate";

/** The event columns an all-in listing price depends on. */
export type ListingBuyerTotalEvent = Pick<
  EventRecord,
  | "id"
  | "orgId"
  | "admissionTaxRateBps"
  | "instructionalAdmission"
  | "placeId"
  | "savedLocationId"
  | "postalCode"
  | "countryCode"
  | "region"
>;

export type ListingBuyerTotalsDeps = {
  repos: BuyerFeeContextBatchRepos & {
    places: Pick<PlacesRepo, "getById" | "getByIds">;
    savedLocations: Pick<SavedLocationsRepo, "getById" | "getByIds">;
  };
  /**
   * CLAUDE.md swallow convention: both degradations below (an unreadable venue
   * situs, a failed fee-context read) return null totals instead of throwing,
   * so this is how they reach Sentry.
   */
  reportError?: ReporterPort;
  logger?: LoggerPort;
};

/**
 * The ALL-IN price a listing quotes for each event — the least a buyer can pay
 * for one ticket, with platform fee, processing fee and tax, exactly as
 * `estimateBuyerTicketPricingForEvent` (and so checkout) computes it.
 *
 * ONE TIER SET WITH `summarizePricing`. Only tiers that rollup counts as PAID
 * contribute: ACTIVE, inside their sales window at `now`, effective listing
 * price > 0 (pay-what-you-want at its floor). So `minPaidPriceCents` and this
 * figure always describe the same tiers — an off-sale cheaper tier can't lend
 * its total to a label quoting the on-sale one.
 *
 * ONE TAX RATE WITH THE EVENT PAGE. The rate is `resolveQuoteTaxRate` — the
 * very function `getCheckoutFeeRates` (the event page's fee rates) calls —
 * with the same situs. So a stamped rate gets the TN instruction-only
 * exemption, an unstamped event takes its venue's cached rate or the Canada
 * table, and a location-less event is 0% — the same number the event page
 * shows.
 *
 * THE TAX PROVIDER IS NEVER CALLED HERE (owner ruling 2026-10-06, which
 * supersedes the 2026-10-04 one that taxed an unknown rate at 0). An event
 * whose venue has no cached rate gets a NULL total — the card says "See
 * details", never a 0% figure — and its venue is QUEUED for a background
 * lookup (`repos.taxRateFills`, at most one request per venue per call). When
 * that fill lands, the job re-indexes the venue's events and the card fills
 * in. Where checkout itself charges 0 without asking anyone (an unsupported
 * province, a provider that already answered "no rate here"), the total is
 * taxed at 0 as before.
 *
 * VALUE PER EVENT:
 *   - the minimum buyer unit total over those tiers;
 *   - `null` when there is no paid tier to quote (the label is decided by the
 *     free/paid counts then, never by this);
 *   - `null` when the venue's tax situs could not be READ (reported). The
 *     taxable base and the cached rate both depend on it, so a total built on
 *     a guess would be an understatement;
 *   - `null` for EVERY event when the fee-context read fails (reported and
 *     logged). Degrading to null makes a paid card say "See details" — never
 *     the face price, which would be a silent understatement too.
 *
 * Every id in `events` gets an entry. ONE instant (`now`) for the whole page,
 * and a FIXED number of queries whatever the page size or venue count: ONE
 * `places.getByIds` and ONE `savedLocations.getByIds` pre-warm a page-scoped
 * reader that the situs batch and every rate quote are then served from, plus
 * `resolveBuyerFeeContexts`.
 */
export async function loadListingBuyerTotalsByEventId(
  deps: ListingBuyerTotalsDeps,
  events: readonly ListingBuyerTotalEvent[],
  tiersByEvent: ReadonlyMap<string, readonly EventTicketTypeSummary[]>,
  now: Date,
  opts: { useCase: string },
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const report = deps.reportError ? safeReporter(deps.reportError) : null;

  const priceable: ListingBuyerTotalEvent[] = [];
  const paidByEvent = new Map<string, EventTicketTypeSummary[]>();
  for (const event of events) {
    if (result.has(event.id)) continue;
    result.set(event.id, null);
    const paid = (tiersByEvent.get(event.id) ?? []).filter(
      (tt) =>
        tt.status === "ACTIVE" &&
        isTicketTypeOnSale(tt, now) &&
        resolveListingPriceCents(tt, now) > 0,
    );
    if (paid.length === 0) continue;
    paidByEvent.set(event.id, paid);
    priceable.push(event);
  }
  if (priceable.length === 0) return result;

  try {
    // One reader for the page, pre-warmed with ONE batch read per table: the
    // situs batch and every per-event rate quote below are served from it, so
    // the page cost does not grow with the number of venues (an org embed with
    // 150 venues is still one places read) — `resolveQuoteTaxRateBps` stays
    // the rule and simply finds its venue row already read.
    //
    // A failed batch read is reported ONCE here, with its venue count. Every
    // venue it covered then rejects with that SAME error object, so the
    // per-venue `onReadError` below skips it instead of filing 150 copies.
    const reportedBatchErrors = new Set<unknown>();
    const reader = await prewarmedTaxRateLocationReader(deps.repos, priceable, {
      onBatchReadError: (err, table, venueCount) => {
        reportedBatchErrors.add(err);
        deps.logger?.error?.("events.listing_buyer_totals.situs_unreadable", {
          err,
          useCase: opts.useCase,
          table,
          venueCount,
        });
        report?.(err, {
          tags: { useCase: opts.useCase, step: "resolveEventTaxSitus" },
          extra: { table, venueCount },
        });
      },
    });
    const taxSitus = await resolveEventTaxSitusBatch(reader, priceable, {
      onReadError: (err, ref) => {
        if (reportedBatchErrors.has(err)) return;
        deps.logger?.error?.("events.listing_buyer_totals.situs_unreadable", {
          err,
          useCase: opts.useCase,
          ref,
        });
        report?.(err, {
          tags: { useCase: opts.useCase, step: "resolveEventTaxSitus" },
          extra: { ref },
        });
      },
    });
    const contexts = await resolveBuyerFeeContexts(deps.repos, priceable, now);

    // `resolveQuoteTaxRate` takes a ClockPort; the page has one instant.
    const clock = { now: () => now };
    // Venues to look up in the background, one entry per venue (the key) for
    // the whole page however many of its events are on it.
    const toFill = new Map<string, TaxRateFillTarget>();

    for (const event of priceable) {
      if (taxSitus.unreadable.has(event.id)) continue;
      const situs = taxSitus.byEvent.get(event.id) ?? null;
      // No `lookup`: a listing never calls the provider inline.
      const quote = await resolveQuoteTaxRate(
        { repos: reader, clock },
        event,
        situs,
        deps.logger,
      );
      if (!quote.known && quote.reason !== "no_rate") {
        // Rate UNKNOWN: no all-in figure ("See details"), never a 0% one.
        if (quote.reason === "not_looked_up" && quote.cacheTarget) {
          const target = quote.cacheTarget;
          toFill.set(
            target.kind === "place"
              ? `place:${target.placeId}`
              : `saved:${target.savedLocationId}`,
            target,
          );
        }
        continue;
      }
      const estimate = computeBuyerTicketPricing(
        contexts.get(event.id) ?? null,
        event,
        paidByEvent.get(event.id) ?? [],
        {
          // A known rate, or (`no_rate`) the 0 checkout itself charges there.
          taxImpositions: resolveTaxImpositions({
            situs,
            salesTaxRateBps: quote.known ? quote.rateBps : 0,
          }),
        },
        now,
      );
      result.set(event.id, estimate.minBuyerUnitTotalCents);
    }
    await requestTaxRateFills(deps, [...toFill.values()], opts.useCase);
    return result;
  } catch (err) {
    deps.logger?.error?.("events.listing_buyer_totals_failed", {
      err,
      useCase: opts.useCase,
      eventCount: priceable.length,
    });
    report?.(err, {
      tags: { useCase: opts.useCase, step: "loadListingBuyerTotals" },
      extra: { eventCount: priceable.length },
    });
    // Discard any partial results: a page whose totals came from two
    // different failure states is harder to reason about than an all-null one.
    for (const id of result.keys()) result.set(id, null);
    return result;
  }
}

/**
 * A {@link TaxRateLocationReader} for ONE listing page, pre-warmed with one
 * `getByIds` per table for every venue the page's events point at (the same
 * Place → SavedLocation precedence `eventTaxRateLocationRef` applies). Point
 * reads are then served from memory; an id outside the warm set falls through
 * to a memoized `getById`, so nothing is ever read twice.
 *
 * A FAILED batch read is NOT swallowed here: every id it covered is seeded
 * with that rejection, so the situs batch sees each affected venue as
 * unreadable (reported through its `onReadError`) and those events get no
 * all-in figure — exactly what a failed point read did before.
 */
async function prewarmedTaxRateLocationReader(
  inner: ListingBuyerTotalsDeps["repos"],
  events: readonly ListingBuyerTotalEvent[],
  hooks: {
    /** Called once per failed batch read, before any venue rejects with it. */
    onBatchReadError: (
      err: unknown,
      table: "places" | "savedLocations",
      venueCount: number,
    ) => void;
  },
): Promise<TaxRateLocationReader> {
  const placeIds = new Set<string>();
  const savedIds = new Set<string>();
  for (const event of events) {
    const ref = eventTaxRateLocationRef(event);
    if (ref?.kind === "place") placeIds.add(ref.placeId);
    if (ref?.kind === "saved-location") savedIds.add(ref.savedLocationId);
  }

  type PlaceRead = ReturnType<TaxRateLocationReader["places"]["getById"]>;
  type SavedRead = ReturnType<
    TaxRateLocationReader["savedLocations"]["getById"]
  >;
  const places = new Map<string, PlaceRead>();
  const saved = new Map<string, SavedRead>();

  const warm = async <R>(
    table: "places" | "savedLocations",
    ids: Set<string>,
    read: (ids: string[]) => Promise<Map<string, R>>,
    into: Map<string, Promise<R | null>>,
  ) => {
    if (ids.size === 0) return;
    try {
      const rows = await read([...ids]);
      for (const id of ids) into.set(id, Promise.resolve(rows.get(id) ?? null));
    } catch (err) {
      hooks.onBatchReadError(err, table, ids.size);
      const failed = Promise.reject(err) as Promise<R | null>;
      // Awaited later by the situs batch; mark handled so the gap between
      // here and that await is not reported as an unhandled rejection.
      failed.catch(() => undefined);
      for (const id of ids) into.set(id, failed);
    }
  };
  await Promise.all([
    warm("places", placeIds, (ids) => inner.places.getByIds(ids), places),
    warm(
      "savedLocations",
      savedIds,
      (ids) => inner.savedLocations.getByIds(ids),
      saved,
    ),
  ]);

  return {
    places: {
      getById: (id) => {
        let read = places.get(id);
        if (!read) {
          read = inner.places.getById(id);
          places.set(id, read);
        }
        return read;
      },
    },
    savedLocations: {
      getById: (id) => {
        let read = saved.get(id);
        if (!read) {
          read = inner.savedLocations.getById(id);
          saved.set(id, read);
        }
        return read;
      },
    },
  };
}

/**
 * The queue the composition root attached to the repos bag
 * (`withTaxRateFillQueue`), or `undefined` — tests, a root with no Cloud
 * Tasks. Structural, like `pendingRepoOf`: the listing's repos type is a Pick.
 */
export function taxRateFillQueueOf(
  repos: object,
): TaxRateFillQueuePort | undefined {
  return (repos as { taxRateFills?: TaxRateFillQueuePort }).taxRateFills;
}

/**
 * Hand the page's unknown-rate venues to the background fill. Awaited (the
 * request must not finish first: Cloud Run starves work after the response),
 * and a DELIBERATE SWALLOW: a failed enqueue costs the cards nothing they
 * did not already lack, so it is reported and the page carries on.
 */
async function requestTaxRateFills(
  deps: ListingBuyerTotalsDeps,
  targets: TaxRateFillTarget[],
  useCase: string,
): Promise<void> {
  if (targets.length === 0) return;
  const queue = taxRateFillQueueOf(deps.repos);
  if (!queue) return;
  try {
    await queue.request(targets);
  } catch (err) {
    try {
      deps.reportError?.(err, {
        tags: { useCase, step: "requestTaxRateFills" },
        extra: { venueCount: targets.length },
      });
    } catch {
      // A throwing reporter must never change the swallow's behaviour.
    }
    deps.logger?.warn?.("events.listing_buyer_totals.tax_fill_enqueue_failed", {
      useCase,
      venueCount: targets.length,
      err,
    });
  }
}
