import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlacesRepo } from "@th/ports/repos/places";
import type { SavedLocationsRepo } from "@th/ports/repos/saved-locations";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";

import { describeError } from "../../../lib/io";
import {
  CANADA_TAX_RATE_SOURCE,
  resolveCanadaGstHst,
} from "../../../lib/tax/canada-rates";
import {
  lookupAdmissionTaxRateOutcome,
  type AdmissionTaxRateResult,
  type TaxRateLookupFailure,
} from "./lookup-admission-tax-rate";

export type ResolveEventTaxRateDeps = {
  taxRateLookup?: TaxRateLookupPort | null;
  clock: ClockPort;
  /**
   * Required by the project's error convention for a deliberate swallow: this
   * function catches and returns a degraded result (`null`), so the failure
   * has to reach Sentry explicitly. It used to log at `warn`, which the pino
   * integration does NOT capture — the swallow was invisible.
   */
  reportError?: ReporterPort;
};

/**
 * The location an event derives its tax rate from. Both the save and publish
 * use cases build one of these from the event's resolved location so the
 * precedence logic (Place → SavedLocation → inline address) lives in one place.
 */
export type EventTaxRateLocationRef =
  | { kind: "place"; placeId: string }
  | { kind: "saved-location"; savedLocationId: string }
  | {
      kind: "inline";
      postalCode: string | null;
      countryCode: string | null;
      /** Two-letter state/province code (Event.region), used for CA province keying + situs. */
      region: string | null;
    };

/**
 * The frozen jurisdiction ("situs") an order's tax is attributed to, derived
 * from the venue location that resolved the rate. Snapshotted onto the Order so
 * historical rollups stay stable even if the venue is later edited (spec §5.2).
 */
export type TaxSitus = {
  /** ISO-3166-1 alpha-2 country code, uppercased ("US" | "CA"). */
  countryCode: string | null;
  /** Two-letter state/province code (e.g. "AB", "FL", "TN"). */
  region: string | null;
  postalCode: string | null;
};

/** A resolved rate plus the jurisdiction it was attributed to. */
export type ResolvedEventTaxRate = {
  rateBps: number;
  source: string;
  situs: TaxSitus;
};

/**
 * The read surface {@link prepareEventTaxRate} needs: point lookups by id on
 * the two rows that can carry a cached rate. Both the root `Repos` (outside a
 * transaction) and a `TxRepos` satisfy it.
 */
export type TaxRateLocationReader = {
  places: Pick<PlacesRepo, "getById">;
  savedLocations: Pick<SavedLocationsRepo, "getById">;
};

/**
 * The backing row a freshly-looked-up rate is cached onto. An inline address
 * has no such row, so a caller resolving inline decides for itself where (or
 * whether) to persist the result.
 */
export type TaxRateCacheTarget =
  | { kind: "place"; placeId: string }
  | { kind: "saved-location"; savedLocationId: string };

/**
 * The output of the READ half of a tax-rate resolution: what to stamp, plus a
 * fresh provider result that has not been written anywhere yet.
 *
 * `fresh` is non-null exactly when the provider was called and answered. The
 * WRITE half ({@link commitPreparedEventTaxRate}) persists it, by
 * compare-and-set only; until then the backing row still says "no cached
 * rate". Splitting the two lets a caller do the provider round trip (a live
 * HTTP call, up to 5s) before it opens a database transaction and the writes
 * after — the reason the split exists. Every in-product caller does exactly
 * that: the event save, publish, the settings re-stamp, and checkout.
 */
export type PreparedEventTaxRate = {
  /**
   * The stamp for the event. `null` means no rate was resolved: either a
   * legitimate no-rate outcome (no location, an unsupported jurisdiction, a
   * provider that answered "no rate here") or an UNKNOWN rate, which
   * `unknown` below flags (a failed lookup, no provider). Never a repo fault
   * (those throw). A null stamp is "unresolved", not 0%: checkout resolves
   * an event whose `admissionTaxRateBps` is null.
   */
  stamp: ResolvedEventTaxRate | null;
  fresh: AdmissionTaxRateResult | null;
  /** The row `fresh` belongs on. `null` for an inline address. */
  cacheTarget: TaxRateCacheTarget | null;
  /**
   * The postal code / country `fresh` was looked up for, as read from the
   * backing row (raw column values). Set exactly when `fresh` is. A write
   * that lands long after the read ({@link fillEventTaxRateCacheIfUnset})
   * matches on it, so an address edit in between is never overwritten with
   * the previous address's rate.
   */
  cacheAddress?: TaxRateCacheAddress | null;
  /**
   * The backing row's address as it was READ when `stamp` was decided (raw
   * column values). Set whenever the resolution read a Place / SavedLocation
   * row — cache hit, fresh lookup, Canada table and no-rate outcomes alike —
   * and absent for an inline address, which has no row that could change.
   *
   * The read can run long before the stamp is written (the save prepares
   * before its transaction, spec P-1). {@link commitPreparedEventTaxRate}
   * compares the row against this inside the transaction and refuses to stamp
   * a rate resolved for an address the row no longer has.
   */
  stampAddress?: TaxRateStampAddress | null;
  /**
   * Set exactly when `stamp` is null because the rate is UNKNOWN, as opposed
   * to legitimately absent (no location, an unsupported province, a provider
   * that answered "no rate here"):
   *  - `lookup_failed` — the provider was asked and the lookup FAILED (rate
   *    limited, bad key, timeout, HTTP error). Checkout refuses on this rather
   *    than charge 0% (owner ruling 2026-10-06); a quote shows no all-in.
   *  - `not_looked_up` — the row has no cached rate and no provider call was
   *    made (none configured, or the caller passed none: the listing quote).
   */
  unknown?: TaxRateUnknown;
};

/** Why a prepared rate is unknown — see `PreparedEventTaxRate.unknown`. */
export type TaxRateUnknown =
  | { reason: "lookup_failed"; failure: TaxRateLookupFailure }
  | { reason: "not_looked_up" };

/** The address a provider lookup was made for — see `cacheAddress`. */
export type TaxRateCacheAddress = {
  postalCode: string | null;
  countryCode: string | null;
};

/**
 * The address a stamp was resolved against — see `stampAddress`. Carries the
 * region too: the Canada table keys on it, and the situs snapshot records it.
 */
export type TaxRateStampAddress = TaxRateCacheAddress & {
  region: string | null;
};

/**
 * A backing location for an event's tax rate: a Place, a SavedLocation, or the
 * event's own inline address.
 */
type ResolvedTaxRateLocation = {
  /** For logging which kind of location resolved the rate. */
  kind: "place" | "saved-location" | "inline";
  cachedRateBps: number | null;
  cachedSource: string | null;
  postalCode: string | null;
  countryCode: string | null;
  /** Two-letter state/province code (region column on the backing row). */
  region: string | null;
  /**
   * Street line and city, for a street-address provider lookup. Null for an
   * inline address (the event carries no street on its tax ref).
   */
  street: string | null;
  city: string | null;
  cacheTarget: TaxRateCacheTarget | null;
};

/**
 * Build the event's tax-rate location preference from its persisted columns.
 * Mirrors the publish-time precedence: Place → SavedLocation → inline address.
 * Returns null when the event has no resolvable location at all.
 */
export function eventTaxRateLocationRef(event: {
  placeId: string | null;
  savedLocationId: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  region?: string | null;
}): EventTaxRateLocationRef | null {
  if (event.placeId) {
    return { kind: "place", placeId: event.placeId };
  }
  if (event.savedLocationId) {
    return { kind: "saved-location", savedLocationId: event.savedLocationId };
  }
  if (event.postalCode && event.countryCode) {
    return {
      kind: "inline",
      postalCode: event.postalCode,
      countryCode: event.countryCode,
      region: event.region ?? null,
    };
  }
  return null;
}

/**
 * Hydrate a {@link EventTaxRateLocationRef} into a {@link ResolvedTaxRateLocation}
 * by reading the backing Place / SavedLocation row (for its cached rate + the
 * row a fresh result would be cached onto). Returns null when the referenced
 * row no longer exists.
 */
async function hydrateTaxRateLocation(
  reader: TaxRateLocationReader,
  ref: EventTaxRateLocationRef,
): Promise<ResolvedTaxRateLocation | null> {
  if (ref.kind === "place") {
    const place = await reader.places.getById(ref.placeId);
    if (!place) return null;
    return {
      kind: "place",
      cachedRateBps: place.admissionTaxRateBps ?? null,
      cachedSource: place.taxRateSource ?? null,
      postalCode: place.postalCode ?? null,
      countryCode: place.countryCode ?? null,
      region: place.region ?? null,
      street: place.addressLine1 ?? null,
      city: place.city ?? null,
      cacheTarget: { kind: "place", placeId: place.id },
    };
  }

  if (ref.kind === "saved-location") {
    const location = await reader.savedLocations.getById(ref.savedLocationId);
    if (!location) return null;
    return {
      kind: "saved-location",
      cachedRateBps: location.admissionTaxRateBps ?? null,
      cachedSource: location.taxRateSource ?? null,
      postalCode: location.postalCode ?? null,
      countryCode: location.countryCode ?? null,
      region: location.region ?? null,
      // Free text as the organizer typed it; the provider normalizes it.
      street: location.address ?? null,
      city: location.locality ?? null,
      cacheTarget: { kind: "saved-location", savedLocationId: location.id },
    };
  }

  // Inline address — nothing to read; the rate is stamped directly on the
  // Event by the caller and there is no backing row to cache onto.
  return {
    kind: "inline",
    cachedRateBps: null,
    cachedSource: null,
    postalCode: ref.postalCode,
    countryCode: ref.countryCode,
    region: ref.region,
    street: null,
    city: null,
    cacheTarget: null,
  };
}

/**
 * Report-and-rethrow for a REPO fault in either half of the resolution. It
 * used to return `null`, and that is the mechanism behind the zero-tax order:
 * `null` is indistinguishable from the LEGITIMATE no-rate outcomes, so
 * `resolveCheckoutTax` read a database fault as "this event has no resolvable
 * tax" and priced the order at $0 — committed, charged, with the platform as
 * merchant of record.
 *
 * Nothing legitimate is lost by throwing. Every expected outcome returns
 * `null` explicitly BEFORE the catch — no location, no provider, an
 * unsupported jurisdiction — and `lookupAdmissionTaxRateOutcome` is itself
 * non-fatal (a FAILED lookup comes back as `unknown`), so a tax-provider
 * outage never reaches here. What does reach
 * here is a repo fault, and inside a transaction that fault has already
 * condemned everything around it. Swallowing only decided the price wrong on
 * the way to a failure that was coming regardless.
 */
function reportTaxRateFault(
  deps: Pick<ResolveEventTaxRateDeps, "reportError">,
  err: unknown,
  logger: LoggerPort | undefined,
  logContext: Record<string, unknown> | undefined,
): never {
  try {
    deps.reportError?.(err, {
      // The tag predates the read/write split; kept so existing Sentry
      // searches and alerts on it still match.
      tags: { useCase: "resolveEventTaxRate" },
      extra: { ...logContext },
    });
  } catch {
    // ignored on purpose
  }
  // `error`, not `warn`: warn is not captured by the Sentry pino integration,
  // so this site reported nothing for the entire time it was a warn — the
  // same shape as the Jun 2026 silent search outage.
  logger?.error("tax_rate_resolution_failed", {
    ...logContext,
    error: describeError(err),
  });
  throw err;
}

/**
 * READ half of a tax-rate resolution: hydrate the backing row, take the
 * cached rate when there is one, otherwise ask the provider. Performs NO
 * writes — a fresh provider answer comes back on `fresh` for the caller to
 * persist through {@link commitPreparedEventTaxRate} (or, for an inline
 * address, onto whatever row the caller mints).
 *
 * Safe to call outside a transaction: the only I/O behind it is two point
 * reads and the provider round trip. That is the point — see P-1 in
 * `docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md`.
 *
 * A FAILED provider lookup is not a fault here (nothing throws): it comes
 * back as a null stamp with `unknown.reason = "lookup_failed"`, reported
 * unless `options.reportLookupFailure` is false (a caller that retries and
 * reports the final outcome itself). What each caller does with an unknown
 * rate is its own decision: publish and the event save stamp NULL (checkout
 * resolves it later), checkout refuses the sale, a quote shows no all-in.
 */
export async function prepareEventTaxRate(
  deps: ResolveEventTaxRateDeps,
  reader: TaxRateLocationReader,
  ref: EventTaxRateLocationRef | null,
  logger: LoggerPort | undefined,
  logContext?: Record<string, unknown>,
  options: { reportLookupFailure?: boolean } = {},
): Promise<PreparedEventTaxRate> {
  const none: PreparedEventTaxRate = {
    stamp: null,
    fresh: null,
    cacheTarget: null,
  };
  if (!ref) {
    return none;
  }

  try {
    const location = await hydrateTaxRateLocation(reader, ref);
    if (!location) {
      return none;
    }

    const stampAddress = rowStampAddress(location);
    const withoutProvider = resolveTaxRateWithoutProvider(
      deps,
      location,
      logger,
      logContext,
    );
    if (withoutProvider !== CACHE_MISS) {
      return {
        stamp: withoutProvider,
        fresh: null,
        cacheTarget: location.cacheTarget,
        ...(stampAddress ? { stampAddress } : {}),
      };
    }

    // Cache miss — last-chance lookup. The write-back is the caller's
    // (`commitPreparedEventTaxRate`, or `fillEventTaxRateCacheIfUnset` after a
    // checkout commits), so this half stays write-free.
    const situs = locationSitus(location);
    const outcome = await lookupAdmissionTaxRateOutcome({
      taxRateLookup: deps.taxRateLookup,
      postalCode: location.postalCode,
      countryCode: location.countryCode,
      address: {
        street: location.street,
        city: location.city,
        region: location.region,
      },
      clock: deps.clock,
      logger,
      logContext: { ...logContext, locationKind: location.kind },
      reportError: deps.reportError,
      reportFailure: options.reportLookupFailure ?? true,
    });
    if (outcome.kind !== "rate") {
      const unknown: TaxRateUnknown | null =
        outcome.kind === "failed"
          ? { reason: "lookup_failed", failure: outcome.failure }
          : // Skipped for want of a PROVIDER (none configured, or the caller
            // passed none) leaves a rate a provider could still find. Skipped
            // for want of a postal code / country is not unknown: no provider
            // could answer that.
            outcome.kind === "skipped" &&
              !deps.taxRateLookup &&
              location.postalCode &&
              location.countryCode
            ? { reason: "not_looked_up" }
            : null;
      return {
        ...none,
        cacheTarget: location.cacheTarget,
        ...(stampAddress ? { stampAddress } : {}),
        ...(unknown ? { unknown } : {}),
      };
    }
    const fresh = outcome.result;

    return {
      stamp: { rateBps: fresh.rateBps, source: fresh.source, situs },
      fresh,
      cacheTarget: location.cacheTarget,
      // Exactly what `lookupAdmissionTaxRate` was asked about above.
      cacheAddress: {
        postalCode: location.postalCode,
        countryCode: location.countryCode,
      },
      ...(stampAddress ? { stampAddress } : {}),
    };
  } catch (err) {
    return reportTaxRateFault(deps, err, logger, logContext);
  }
}

/** Sentinel: the row has no cached rate and is not in a static-table country. */
const CACHE_MISS = Symbol("tax-rate-cache-miss");

function locationSitus(location: ResolvedTaxRateLocation): TaxSitus {
  return normalizeTaxSitus(
    location.countryCode,
    location.region,
    location.postalCode,
  );
}

/** The row's address as read, or null for an inline address (no row). */
function rowStampAddress(
  location: ResolvedTaxRateLocation,
): TaxRateStampAddress | null {
  if (!location.cacheTarget) return null;
  return {
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    region: location.region,
  };
}

/**
 * Everything {@link prepareEventTaxRate} can decide WITHOUT the provider: the
 * Canada table, then the row's cached rate. Returns {@link CACHE_MISS} when
 * only a provider call could answer. Shared with the in-transaction re-resolve
 * in {@link commitPreparedEventTaxRate}, which must never call the provider.
 */
function resolveTaxRateWithoutProvider(
  deps: Pick<ResolveEventTaxRateDeps, "reportError">,
  location: ResolvedTaxRateLocation,
  logger: LoggerPort | undefined,
  logContext: Record<string, unknown> | undefined,
): ResolvedEventTaxRate | null | typeof CACHE_MISS {
  const situs = locationSitus(location);

  // ── Canada branch (§5.1) ──────────────────────────────────────────────
  // Canadian jurisdictions are a small, static province-level table — no
  // external API. Short-circuit BEFORE the US-only ZipTax port so Canadian
  // events collect GST/HST instead of $0. An unknown / unsupported province
  // resolves to no rate, logged at warn and reported: warn alone never
  // reaches Sentry.
  if (situs.countryCode === "CA") {
    const { province, rateBps } = resolveCanadaGstHst({
      region: situs.region,
      postalCode: situs.postalCode,
    });
    // Prefer the resolved province code for the situs when region was blank.
    const caSitus: TaxSitus = { ...situs, region: province };
    if (rateBps == null) {
      logger?.warn("tax_rate_ca_province_unsupported", {
        ...logContext,
        locationKind: location.kind,
        region: situs.region,
        postalCode: situs.postalCode,
        resolvedProvince: province,
      });
      try {
        deps.reportError?.(new Error("tax_rate_ca_province_unsupported"), {
          tags: {
            useCase: "resolveEventTaxRate",
            reason: "ca_province_unsupported",
          },
          extra: {
            ...logContext,
            locationKind: location.kind,
            region: situs.region,
            postalCode: situs.postalCode,
            resolvedProvince: province,
          },
        });
      } catch {
        // ignored on purpose
      }
      return null;
    }
    return { rateBps, source: CANADA_TAX_RATE_SOURCE, situs: caSitus };
  }

  if (location.cachedRateBps != null) {
    return {
      rateBps: location.cachedRateBps,
      source: location.cachedSource ?? "unknown",
      situs,
    };
  }

  return CACHE_MISS;
}

function sameStampAddress(
  location: ResolvedTaxRateLocation,
  address: TaxRateStampAddress,
): boolean {
  // Raw column equality, the same comparison the repos' `fillTaxRateIfUnset`
  // makes on postal code and country.
  return (
    location.postalCode === address.postalCode &&
    location.countryCode === address.countryCode &&
    location.region === address.region
  );
}

function sameCacheTarget(
  a: TaxRateCacheTarget | null,
  b: TaxRateCacheTarget | null,
): boolean {
  if (!a || !b) return false;
  if (a.kind === "place" && b.kind === "place") return a.placeId === b.placeId;
  if (a.kind === "saved-location" && b.kind === "saved-location") {
    return a.savedLocationId === b.savedLocationId;
  }
  return false;
}

function cacheTargetRef(target: TaxRateCacheTarget): EventTaxRateLocationRef {
  return target.kind === "place"
    ? { kind: "place", placeId: target.placeId }
    : { kind: "saved-location", savedLocationId: target.savedLocationId };
}

/**
 * WRITE half for a resolution PREPARED BEFORE the caller's transaction (the
 * event save, spec P-1; publish and the settings re-stamp go through
 * {@link commitPreparedEventTaxRateForRef}, which lands here). Runs inside the
 * transaction; resolves the stamp the caller should write onto the event.
 * Never calls the provider.
 *
 * The pre-transaction read is not covered by any lock the transaction takes,
 * so the backing row may have changed since: `upsertPlace` can move the venue
 * and cache the NEW address's rate, and a checkout's self-heal can fill an
 * empty cache. Two guards keep the prepared result from undoing either:
 *
 * 1. The STAMP. When `stampAddress` is set and the row is still the one the
 *    stamp was read from, the row is re-read here and compared. If its
 *    postal code / country / region moved, the prepared stamp is for an
 *    address the venue no longer has: it is dropped, and the stamp is
 *    re-resolved from the row as it is now — its cached rate (which
 *    `upsertPlace` looked up for the new address) or the Canada table — and
 *    otherwise `null`. A null stamp is "unresolved", not "0%": checkout's
 *    `prepareCheckoutTax` resolves an event whose `admissionTaxRateBps` is
 *    null. For a Place, the caller must already hold the SHARED
 *    place-location lock (`events.lockLocationsAtPlace`), which `upsertPlace`
 *    takes EXCLUSIVE, so the row cannot move again before commit.
 *
 * 2. The CACHE. A fresh provider answer is written with the compare-and-set
 *    `fillTaxRateIfUnset`: only while the row's cache is still empty AND it
 *    still has the postal code / country the lookup was for. A skipped write
 *    is not an error (someone else cached a rate, or the address moved); it
 *    is logged at info and costs at most one more lookup later.
 *
 * `cacheTarget` overrides where the fresh answer is cached: a freeform save
 * caches onto the SavedLocation it minted or linked inside the transaction,
 * which the pre-transaction read could not name. The address check in (1)
 * applies only when that row is the one the stamp was read from; a minted row
 * carries exactly the typed address the inline lookup used, and the CAS in (2)
 * still guards its cache.
 *
 * A repo fault is reported and rethrown, as in the read half.
 */
export async function commitPreparedEventTaxRate(
  deps: Pick<ResolveEventTaxRateDeps, "reportError">,
  tx: TxRepos,
  prepared: PreparedEventTaxRate,
  logger: LoggerPort | undefined,
  logContext?: Record<string, unknown>,
  options: {
    cacheTarget?: TaxRateCacheTarget | null;
    /**
     * Called when the compare-and-set actually FILLED the row's cache. Runs
     * inside the transaction: record the target and act on it after the
     * commit (the other events at that venue now have a rate their search
     * documents do not show — `reindexEventsAtTaxLocation`).
     */
    onCacheFilled?: (target: TaxRateCacheTarget) => void;
  } = {},
): Promise<ResolvedEventTaxRate | null> {
  const cacheTarget =
    options.cacheTarget !== undefined
      ? options.cacheTarget
      : prepared.cacheTarget;

  try {
    if (
      prepared.stampAddress &&
      prepared.cacheTarget &&
      sameCacheTarget(cacheTarget, prepared.cacheTarget)
    ) {
      const current = await hydrateTaxRateLocation(
        tx,
        cacheTargetRef(prepared.cacheTarget),
      );
      if (!current || !sameStampAddress(current, prepared.stampAddress)) {
        const restamp = current
          ? resolveTaxRateWithoutProvider(deps, current, logger, logContext)
          : null;
        const stamp = restamp === CACHE_MISS ? null : restamp;
        logger?.info("tax_rate_stamp_skipped_location_changed", {
          ...logContext,
          locationKind: prepared.cacheTarget.kind,
          locationGone: current === null,
          preparedRateBps: prepared.stamp?.rateBps ?? null,
          stampedRateBps: stamp?.rateBps ?? null,
        });
        return stamp;
      }
    }

    const { fresh, cacheAddress } = prepared;
    if (fresh && cacheTarget && cacheAddress) {
      const write = {
        expectedPostalCode: cacheAddress.postalCode,
        expectedCountryCode: cacheAddress.countryCode,
        admissionTaxRateBps: fresh.rateBps,
        taxRateSource: fresh.source,
        taxRateFetchedAt: fresh.fetchedAt,
      };
      const wrote =
        cacheTarget.kind === "place"
          ? await tx.places.fillTaxRateIfUnset({
              id: cacheTarget.placeId,
              ...write,
            })
          : await tx.savedLocations.fillTaxRateIfUnset({
              id: cacheTarget.savedLocationId,
              ...write,
            });
      logger?.info(
        wrote
          ? "tax_rate_cached_on_resolve"
          : "tax_rate_cache_skipped_location_changed",
        {
          ...logContext,
          locationKind: cacheTarget.kind,
          rateBps: fresh.rateBps,
          source: fresh.source,
        },
      );
      if (wrote) options.onCacheFilled?.(cacheTarget);
    }
    return prepared.stamp;
  } catch (err) {
    return reportTaxRateFault(deps, err, logger, logContext);
  }
}

/**
 * A resolution {@link prepareEventTaxRate} made BEFORE a transaction, with the
 * location ref it was made for. The ref comes from a pre-transaction read of
 * the event, so the transaction has to check it is still the event's location
 * — see {@link commitPreparedEventTaxRateForRef}.
 */
export type PreparedEventTaxRateForRef = {
  ref: EventTaxRateLocationRef | null;
  prepared: PreparedEventTaxRate;
};

/**
 * In-transaction half for a caller that decides inside its transaction WHICH
 * location to stamp from (publish, the settings re-stamp): it read the event
 * before the transaction to prepare the rate, and reads it again inside.
 *
 * - `ref` is the event's location as read INSIDE the transaction. When it is
 *   the location `preparedForRef` was made for, this is exactly
 *   {@link commitPreparedEventTaxRate}: re-read the row, drop a stamp for an
 *   address the row no longer has, cache by compare-and-set.
 * - Otherwise (the event moved between the two reads, or the pre-transaction
 *   read decided nothing needed preparing) the prepared result is about some
 *   other location and is discarded. The stamp is resolved from `ref`'s row
 *   as it is now, WITHOUT the provider: its cached rate, the Canada table, or
 *   `null` — "unresolved", which checkout resolves, never 0%. Nothing is
 *   cached. The provider call is not made here because it would hold this
 *   transaction's connection across a third-party HTTP call (up to 5s).
 *
 * For a `place` ref the caller must already hold the SHARED
 * `events.lockLocationsAtPlace` for that place (`upsertPlace` takes it
 * EXCLUSIVE before moving a venue), taken before any event-row write in the
 * transaction: `upsertPlace` takes the advisory lock and then rewrites event
 * rows, so the reverse order deadlocks.
 *
 * A repo fault is reported and rethrown, as in both halves.
 */
export async function commitPreparedEventTaxRateForRef(
  deps: Pick<ResolveEventTaxRateDeps, "clock" | "reportError">,
  tx: TxRepos,
  ref: EventTaxRateLocationRef | null,
  preparedForRef: PreparedEventTaxRateForRef | null,
  logger: LoggerPort | undefined,
  logContext?: Record<string, unknown>,
  options: {
    /** See {@link commitPreparedEventTaxRate}'s `onCacheFilled`. */
    onCacheFilled?: (target: TaxRateCacheTarget) => void;
  } = {},
): Promise<ResolvedEventTaxRate | null> {
  if (preparedForRef && sameLocationRef(preparedForRef.ref, ref)) {
    return commitPreparedEventTaxRate(
      deps,
      tx,
      preparedForRef.prepared,
      logger,
      logContext,
      options.onCacheFilled ? { onCacheFilled: options.onCacheFilled } : {},
    );
  }

  logger?.info("tax_rate_resolved_in_tx_without_provider", {
    ...logContext,
    reason: preparedForRef ? "location_changed" : "not_prepared",
    locationKind: ref?.kind ?? null,
  });
  const fromRow = await prepareEventTaxRate(
    { clock: deps.clock, reportError: deps.reportError, taxRateLookup: null },
    tx,
    ref,
    logger,
    logContext,
  );
  return fromRow.stamp;
}

function sameLocationRef(
  a: EventTaxRateLocationRef | null,
  b: EventTaxRateLocationRef | null,
): boolean {
  if (!a || !b) return a === b;
  return taxSitusRefKey(a) === taxSitusRefKey(b);
}

/**
 * CONDITIONAL write half, for a cache write that lands long after the read
 * that triggered the lookup — the checkout's, which runs after its whole
 * transaction (PaymentIntent included) has committed.
 *
 * An unconditional write is wrong this far from the read: a checkout that
 * looked up the venue's OLD postal code would put that rate back over the one
 * `upsertPlace` cached for the NEW address. So this writes ONLY while the row's cache is still empty AND the row still
 * has the postal code / country the lookup was for (the repos'
 * `fillTaxRateIfUnset`). A skipped write costs one more lookup next time.
 *
 * Resolves `true` when it wrote. No-op (`false`) when nothing fresh was
 * fetched, there is no backing row (inline address), or the prepared result
 * does not carry the address it was looked up for. A repo fault is reported
 * and rethrown, exactly as {@link commitPreparedEventTaxRate} does.
 *
 * Takes the full `Repos` bag: a post-commit helper must not be handed a
 * transaction (engineering standards, "Swallowing an error inside a
 * transaction").
 */
export async function fillEventTaxRateCacheIfUnset(
  deps: Pick<ResolveEventTaxRateDeps, "reportError">,
  repos: Repos,
  prepared: Pick<PreparedEventTaxRate, "fresh" | "cacheTarget" | "cacheAddress">,
  logger: LoggerPort | undefined,
  logContext?: Record<string, unknown>,
): Promise<boolean> {
  const { fresh, cacheTarget, cacheAddress } = prepared;
  if (!fresh || !cacheTarget || !cacheAddress) {
    return false;
  }

  try {
    const write = {
      expectedPostalCode: cacheAddress.postalCode,
      expectedCountryCode: cacheAddress.countryCode,
      admissionTaxRateBps: fresh.rateBps,
      taxRateSource: fresh.source,
      taxRateFetchedAt: fresh.fetchedAt,
    };
    const wrote =
      cacheTarget.kind === "place"
        ? await repos.places.fillTaxRateIfUnset({
            id: cacheTarget.placeId,
            ...write,
          })
        : await repos.savedLocations.fillTaxRateIfUnset({
            id: cacheTarget.savedLocationId,
            ...write,
          });
    logger?.info(
      wrote
        ? "tax_rate_cached_on_resolve"
        : "tax_rate_cache_skipped_location_changed",
      {
        ...logContext,
        locationKind: cacheTarget.kind,
        rateBps: fresh.rateBps,
        source: fresh.source,
      },
    );
    return wrote;
  } catch (err) {
    return reportTaxRateFault(deps, err, logger, logContext);
  }
}

/**
 * Normalise a raw location triple into a {@link TaxSitus}.
 *
 * ONE normalisation for every situs the product produces — the rate/publish
 * path ({@link prepareEventTaxRate}), the checkout snapshot
 * (`resolveCheckoutTax`) and the read-only estimators all go through here, so a
 * taxable-base lookup can never disagree with the charge because one site
 * uppercased the region and another did not.
 */
export function normalizeTaxSitus(
  countryCode: string | null | undefined,
  region: string | null | undefined,
  postalCode: string | null | undefined,
): TaxSitus {
  return {
    countryCode: countryCode?.toUpperCase() ?? null,
    region: region?.trim().toUpperCase() || null,
    postalCode: postalCode ?? null,
  };
}

/**
 * Resolve ONLY the venue situs for an event — no rate lookup, no provider call,
 * no cache write-back. Two point reads at worst (Place or SavedLocation);
 * nothing at all for an inline address or an event with no location.
 *
 * This is the read the taxable-base rule needs: the jurisdiction decides both
 * the rate AND what the rate applies to, so any surface that quotes a
 * tax-inclusive price has to know the situs, not just the stamped rate.
 *
 * Throws on a repo fault (same reasoning as {@link prepareEventTaxRate}: a null
 * here is indistinguishable from "no location", and reading a database fault as
 * "no jurisdiction" is how an order gets priced wrong). Callers that must not
 * fail on a situs miss wrap it — `resolveCheckoutTax` does.
 */
export async function resolveEventTaxSitus(
  reader: TaxRateLocationReader,
  event: {
    placeId: string | null;
    savedLocationId: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
    region?: string | null;
  },
): Promise<TaxSitus | null> {
  const ref = eventTaxRateLocationRef(event);
  if (!ref) return null;
  return resolveTaxSitusFromRef(reader, ref);
}

/**
 * {@link resolveEventTaxSitus} for a ref a caller already built.
 */
export async function resolveTaxSitusFromRef(
  reader: TaxRateLocationReader,
  ref: EventTaxRateLocationRef,
): Promise<TaxSitus | null> {
  if (ref.kind === "place") {
    const place = await reader.places.getById(ref.placeId);
    if (!place) return null;
    return normalizeTaxSitus(place.countryCode, place.region, place.postalCode);
  }
  if (ref.kind === "saved-location") {
    const location = await reader.savedLocations.getById(ref.savedLocationId);
    if (!location) return null;
    return normalizeTaxSitus(
      location.countryCode,
      location.region,
      location.postalCode,
    );
  }
  return normalizeTaxSitus(ref.countryCode, ref.region, ref.postalCode);
}

/**
 * The per-event situs for a batch, plus the events whose situs could NOT be read.
 */
export type EventTaxSitusBatch = {
  /** eventId → situs (`null` = the event has no resolvable location). */
  byEvent: Map<string, TaxSitus | null>;
  /**
   * Event ids whose backing Place / SavedLocation read FAILED. Distinct from a
   * `null` situs on purpose: "no location" is a fact, "we could not read it" is
   * an unknown, and a caller must not compute a taxable base from an unknown.
   */
  unreadable: Set<string>;
};

/**
 * {@link resolveEventTaxSitus} for a BATCH of events, deduplicated.
 *
 * A full search reindex walks every published event, and the situs decides the
 * taxable base for the all-in buyer total it stores — so the read cannot simply
 * be skipped. It CAN be shared: events at the same venue resolve the same Place
 * row, so this reads each distinct Place / SavedLocation once per batch instead
 * of once per event. Inline addresses and location-less events cost nothing.
 *
 * FAULT HANDLING. Without `onReadError` this throws, like
 * {@link resolveEventTaxSitus} — a charge path must never read a database fault
 * as "no jurisdiction". With `onReadError` a failed read is reported to the
 * caller and the affected events land in `unreadable`, which is what a
 * background reindex wants: one unreachable venue must not fail the batch, but
 * it must also not silently produce an all-in price from a guessed base.
 */
export async function resolveEventTaxSitusBatch(
  reader: TaxRateLocationReader,
  events: ReadonlyArray<{
    id: string;
    placeId: string | null;
    savedLocationId: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
    region?: string | null;
  }>,
  opts?: {
    /** Present = tolerate a failed read (and report it); absent = throw. */
    onReadError?: (err: unknown, ref: EventTaxRateLocationRef) => void;
  },
): Promise<EventTaxSitusBatch> {
  const byEvent = new Map<string, TaxSitus | null>();
  const unreadable = new Set<string>();
  // Keyed by the backing row so N events at one venue cost ONE read — and one
  // failed venue is reported ONCE, not once per event on it.
  const cache = new Map<string, TaxSitus | null | typeof READ_FAILED>();

  for (const event of events) {
    const ref = eventTaxRateLocationRef(event);
    if (!ref) {
      byEvent.set(event.id, null);
      continue;
    }
    const key = taxSitusRefKey(ref);

    if (!cache.has(key)) {
      try {
        cache.set(key, await resolveTaxSitusFromRef(reader, ref));
      } catch (err) {
        if (!opts?.onReadError) throw err;
        try {
          opts.onReadError(err, ref);
        } catch {
          // The tolerant path exists so one unreachable venue cannot fail the
          // batch. A reporter that throws must not undo that (CLAUDE.md: a
          // throwing reporter never changes behaviour).
        }
        cache.set(key, READ_FAILED);
      }
    }
    const cached = cache.get(key);
    if (cached === READ_FAILED) {
      unreadable.add(event.id);
      byEvent.set(event.id, null);
      continue;
    }
    byEvent.set(event.id, cached ?? null);
  }

  return { byEvent, unreadable };
}

/** Sentinel for "this backing row could not be read", distinct from `null`. */
const READ_FAILED = Symbol("tax-situs-read-failed");

/**
 * A stable identity for a location ref: equal keys mean "the same backing
 * row" (Place / SavedLocation) or "the same inline address". Used to dedupe
 * situs reads, and by checkout to check that a rate prepared before its
 * transaction is still the event's location inside it.
 */
export function taxSitusRefKey(ref: EventTaxRateLocationRef): string {
  if (ref.kind === "place") return `place:${ref.placeId}`;
  if (ref.kind === "saved-location") return `saved:${ref.savedLocationId}`;
  return `inline:${ref.countryCode ?? ""}|${ref.region ?? ""}|${ref.postalCode ?? ""}`;
}
