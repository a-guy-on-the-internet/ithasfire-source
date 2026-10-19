import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";

import { applyInstructionExemption } from "../../../lib/tax/instruction-exemption";
import { reindexEventsAtTaxLocation } from "../../tax/reindex-events-at-tax-location";
import type { QuoteTaxLookupCooldown } from "./quote-tax-lookup-cooldown";
import {
  eventTaxRateLocationRef,
  fillEventTaxRateCacheIfUnset,
  prepareEventTaxRate,
  taxSitusRefKey,
  type TaxRateCacheTarget,
  type TaxRateLocationReader,
  type TaxSitus,
} from "./resolve-event-tax-rate";

/**
 * What a quote needs to LOOK UP a rate the venue has not cached yet, and to
 * cache the answer. Present only on a quote that may call the provider (the
 * event page and checkout fee preview); absent on listings, which must never
 * call the provider inline.
 */
export type QuoteTaxRateLookupDeps = {
  /** Null/undefined = no provider configured; nothing is looked up. */
  taxRateLookup: TaxRateLookupPort | null | undefined;
  /** The full repos bag: the cache fill runs on it, outside any transaction. */
  repos: Repos;
  /** Present = the venue's other events are re-indexed at once after a fill. */
  search?: MultiSearchPort;
  /**
   * Quotes fire per page view, so the composition root passes a THROTTLED
   * reporter here (`createThrottledReporter`): during an outage one report per
   * window, not one per view. Checkout reports through its own, unthrottled.
   */
  reportError?: ReporterPort;
  /**
   * Per-venue negative cache (`createQuoteTaxLookupCooldown`, one per
   * process). A venue whose lookup failed recently is not looked up again
   * until the cooldown passes; its quotes come back `lookup_failed`. Absent =
   * every quote may ask the provider.
   */
  cooldown?: QuoteTaxLookupCooldown;
};

/**
 * A quote's rate, or why there is none:
 *  - `lookup_failed` — the provider was asked and the lookup FAILED. Show no
 *    all-in figure; checkout would refuse this sale (`TAX_RATE_UNAVAILABLE`).
 *  - `not_looked_up` — the venue has no cached rate and this quote did not
 *    (or could not) ask the provider. `cacheTarget` is the venue row a
 *    background fill should look up for, when there is one.
 *  - `no_rate` — nothing to look up that would answer: an unsupported
 *    province, a missing venue row, a provider that answered "no rate here".
 *    Checkout charges 0 there, but the quote keeps showing no figure, as it
 *    always has.
 */
export type QuoteTaxRate =
  | { known: true; rateBps: number }
  | {
      known: false;
      reason: "lookup_failed" | "not_looked_up" | "no_rate";
      cacheTarget: TaxRateCacheTarget | null;
    };

type QuoteTaxRateEvent = {
  id: string;
  admissionTaxRateBps?: number | null;
  instructionalAdmission?: boolean | null;
  placeId: string | null;
  savedLocationId: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  region?: string | null;
};

/**
 * The admission tax rate a pre-checkout QUOTE should tax at: the rate checkout
 * would charge, decided WITHOUT the tax provider. Returns `null` when only the
 * provider could answer, so the quote cannot know the rate.
 *
 * Why this exists: a NULL `event.admissionTaxRateBps` does not mean "no tax".
 * Checkout resolves the rate live (`resolveCheckoutTax`): the Canada table,
 * then the Place / SavedLocation cached rate, then ZipTax. A quote that read a
 * NULL stamp as 0% showed an all-in price BELOW the charge.
 *
 * This runs every step of that resolution except the provider call:
 *  - stamped → the stamp, with the TN instruction-only exemption applied
 *    against `situs` exactly as checkout's fast path applies it (an organizer
 *    who turned `instructionalAdmission` on after publish leaves a stale
 *    non-zero stamp that checkout corrects to 0).
 *  - no location at all → 0. Checkout charges 0 here too
 *    (`prepareEventTaxRate` returns no stamp for a null ref).
 *  - Canada table or a cached venue rate → that rate, with the TN
 *    instruction-only exemption applied exactly as checkout applies it.
 *  - a cache miss → with `deps.lookup`, the provider's answer (cached on the
 *    venue); without it, or when the lookup FAILED → `null`.
 *  - an unsupported province, a missing venue row, a provider that answered
 *    "no rate here" → `null`. Checkout ends at 0 for those, but the quote
 *    has never shown a figure for them and still does not.
 * An unknown rate is never shown as a known 0. {@link resolveQuoteTaxRate}
 * returns the same answer with the reason kept.
 *
 * `situs` is the caller's `resolveEventTaxSitus(repos, event)` — the same
 * venue-precedence situs checkout's stamped path exempts against
 * (`resolveSitusOnly` → `resolveTaxSitusFromRef`). Required, so a caller
 * cannot skip the exemption by omission.
 *
 * Not deduplicated: an UNSTAMPED event reads its venue row twice (the caller's
 * situs read, then `prepareEventTaxRate`'s cache read). Sharing that read
 * means changing `prepareEventTaxRate`'s API; it costs one point read only on
 * the rare unstamped event, so it is left as is.
 *
 * The provider is called only when the caller passes `deps.lookup` (the
 * event page / checkout fee preview — owner ruling 2026-10-06: look the rate
 * up by address ONCE per venue and cache it, never show 0% for an unknown
 * rate). The answer is cached on the venue row with the same compare-and-set
 * fill checkout uses (`fillEventTaxRateCacheIfUnset`), so the next quote,
 * checkout and listing all read it, and the venue's other events are
 * re-indexed so their search cards get the new all-in total. Listings never
 * pass it: they return no all-in figure and queue a background fill. This
 * supersedes the 2026-10-04 ruling that a pre-hold preview may show 0%.
 *
 * A repo fault THROWS (`prepareEventTaxRate` reports and rethrows) — nothing
 * here swallows, so a database error is never read as "rate unknown".
 */
export async function resolveQuoteTaxRateBps(
  deps: {
    repos: TaxRateLocationReader;
    clock: ClockPort;
    lookup?: QuoteTaxRateLookupDeps | null;
  },
  event: QuoteTaxRateEvent,
  situs: TaxSitus | null,
  logger?: LoggerPort,
): Promise<number | null> {
  const quote = await resolveQuoteTaxRate(deps, event, situs, logger);
  return quote.known ? quote.rateBps : null;
}

/**
 * {@link resolveQuoteTaxRateBps} with the reason for an unknown rate kept —
 * the caller decides what each one means (the fee preview refuses on
 * `lookup_failed`, a listing queues a fill on `not_looked_up`).
 */
export async function resolveQuoteTaxRate(
  deps: {
    repos: TaxRateLocationReader;
    clock: ClockPort;
    lookup?: QuoteTaxRateLookupDeps | null;
  },
  event: QuoteTaxRateEvent,
  situs: TaxSitus | null,
  logger?: LoggerPort,
): Promise<QuoteTaxRate> {
  // `!= null` also lets `undefined` through to the resolution below (the field
  // is optional on EventRecord).
  if (event.admissionTaxRateBps != null) {
    return {
      known: true,
      rateBps: applyInstructionExemption({
        instructionalAdmission: event.instructionalAdmission,
        situs,
        rateBps: event.admissionTaxRateBps,
        source: "stamp",
      }).rateBps,
    };
  }

  const ref = eventTaxRateLocationRef(event);
  if (!ref) return { known: true, rateBps: 0 };

  const lookup = deps.lookup ?? null;
  // A venue whose lookup just failed is not asked about again on every view
  // (see QuoteTaxLookupCooldown). Cached rates still read: only the provider
  // call is skipped.
  const cooldownKey =
    lookup?.cooldown && lookup.taxRateLookup ? taxSitusRefKey(ref) : null;
  const nowMs = cooldownKey ? deps.clock.now().getTime() : 0;
  const coolingDown =
    cooldownKey !== null && lookup!.cooldown!.isCoolingDown(cooldownKey, nowMs);
  const prepared = await prepareEventTaxRate(
    {
      taxRateLookup: coolingDown ? null : (lookup?.taxRateLookup ?? null),
      clock: deps.clock,
      ...(lookup?.reportError ? { reportError: lookup.reportError } : {}),
    },
    deps.repos,
    ref,
    logger,
    { eventId: event.id, source: "quote" },
  );

  if (cooldownKey && prepared.unknown?.reason === "lookup_failed") {
    lookup!.cooldown!.noteFailure(cooldownKey, nowMs);
  }

  if (lookup && prepared.fresh && prepared.cacheTarget) {
    await fillQuoteCache(lookup, prepared, logger, event.id);
  }

  if (!prepared.stamp) {
    return {
      known: false,
      // Skipped only because the venue is cooling down after a FAILED lookup:
      // that is still a failed lookup, not "nobody asked".
      reason:
        coolingDown && prepared.unknown?.reason === "not_looked_up"
          ? "lookup_failed"
          : (prepared.unknown?.reason ?? "no_rate"),
      cacheTarget: prepared.cacheTarget,
    };
  }

  return {
    known: true,
    rateBps: applyInstructionExemption({
      instructionalAdmission: event.instructionalAdmission,
      situs: prepared.stamp.situs,
      rateBps: prepared.stamp.rateBps,
      source: prepared.stamp.source,
    }).rateBps,
  };
}

/**
 * Cache a rate the quote just looked up, with checkout's compare-and-set
 * (only an empty cache, only at the address it was looked up for), then
 * refresh the venue's other events. Best-effort: the quote already has its
 * rate; a failed write is reported inside `fillEventTaxRateCacheIfUnset` and
 * costs one more lookup next time.
 */
async function fillQuoteCache(
  lookup: QuoteTaxRateLookupDeps,
  prepared: Awaited<ReturnType<typeof prepareEventTaxRate>>,
  logger: LoggerPort | undefined,
  eventId: string,
): Promise<void> {
  const deps = {
    ...(lookup.reportError ? { reportError: lookup.reportError } : {}),
  };
  let filled = false;
  try {
    filled = await fillEventTaxRateCacheIfUnset(
      deps,
      lookup.repos,
      prepared,
      logger,
      { eventId, source: "quote" },
    );
  } catch {
    // Reported (and logged) by fillEventTaxRateCacheIfUnset.
  }
  if (filled && prepared.cacheTarget && prepared.fresh) {
    reindexEventsAtTaxLocation(
      {
        repos: lookup.repos,
        ...(lookup.search ? { search: lookup.search } : {}),
        ...(logger ? { logger } : {}),
        ...(lookup.reportError ? { reportError: lookup.reportError } : {}),
      },
      prepared.cacheTarget,
      {
        now: prepared.fresh.fetchedAt,
        useCase: "quoteTaxCacheFill",
        // The quoted event itself is unstamped too, and the listing query
        // returns it: no need to name it.
      },
    );
  }
}
