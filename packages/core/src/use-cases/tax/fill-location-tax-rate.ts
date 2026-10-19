import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";

import { parseInput } from "../../lib/io";
import {
  fillEventTaxRateCacheIfUnset,
  prepareEventTaxRate,
  type EventTaxRateLocationRef,
  type TaxRateCacheTarget,
} from "../events/_shared/resolve-event-tax-rate";
import { runReindexEventsAtTaxLocation } from "./reindex-events-at-tax-location";

export const fillLocationTaxRateInputSchema = z
  .object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("place"), placeId: z.uuid() }).strict(),
      z
        .object({
          kind: z.literal("saved-location"),
          savedLocationId: z.uuid(),
        })
        .strict(),
    ]),
  })
  .strict();

export type FillLocationTaxRateDeps = {
  repos: Repos;
  taxRateLookup: TaxRateLookupPort | null | undefined;
  clock: ClockPort;
  logger?: LoggerPort;
  reportError?: ReporterPort;
  /**
   * Present = the venue's events are re-indexed at once after a fill. Absent
   * = they are only MARKED, and the scheduled search drain re-indexes them.
   */
  search?: MultiSearchPort;
};

export type FillLocationTaxRateOutput = {
  status:
    | "filled"
    | "already_cached"
    | "not_filled"
    | "no_rate"
    | "no_provider"
    | "location_gone";
  /** Events re-indexed (or marked for it) after a fill, or on finding the rate already cached. */
  reindexedEventCount: number;
};

/**
 * Background job body (`tax.fill-location-rate`, queued by listings through
 * `repos.taxRateFills`): look up the tax rate for ONE venue row whose cache is
 * empty, fill the cache with the same compare-and-set checkout uses
 * (`fillEventTaxRateCacheIfUnset` — only an empty cache, only at the address
 * looked up), and re-index the venue's unstamped upcoming events so their
 * search cards get an all-in total instead of "See details". A venue found
 * already cached (the event page looked it up first) is re-indexed too.
 *
 * A FAILED lookup THROWS (the provider's `TaxRateLookupError`): the jobs app
 * answers non-2xx only when the handler throws, and that is what makes Cloud
 * Tasks retry the task. The error reaches Sentry through the jobs backstop.
 * Everything else is a normal outcome, returned.
 */
export async function fillLocationTaxRate(
  deps: FillLocationTaxRateDeps,
  rawInput: unknown,
): Promise<FillLocationTaxRateOutput> {
  const { target } = parseInput(fillLocationTaxRateInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "fillLocationTaxRate" });
  const ref: EventTaxRateLocationRef =
    target.kind === "place"
      ? { kind: "place", placeId: target.placeId }
      : { kind: "saved-location", savedLocationId: target.savedLocationId };
  const logContext = { source: "background_fill", target };

  const prepared = await prepareEventTaxRate(
    {
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      ...(deps.reportError ? { reportError: deps.reportError } : {}),
    },
    deps.repos,
    ref,
    logger,
    logContext,
    // Thrown below instead, so the jobs backstop reports it once.
    { reportLookupFailure: false },
  );

  if (prepared.unknown?.reason === "lookup_failed") {
    throw prepared.unknown.failure.error;
  }
  if (!prepared.cacheTarget) {
    return done("location_gone");
  }
  if (prepared.stamp && !prepared.fresh) {
    // Cached by someone else since the listing asked (the event page's quote
    // path caches a place's rate and marks nothing), or a Canada-table row.
    // The listing that queued this job still has null all-in totals on the
    // place's events, so refresh them here too; a no-op when none are left.
    const { eventIds } = await reindexAtTarget(
      prepared.cacheTarget,
      deps.clock.now(),
    );
    return done("already_cached", eventIds.length);
  }
  if (!prepared.fresh) {
    return done(
      prepared.unknown?.reason === "not_looked_up" ? "no_provider" : "no_rate",
    );
  }

  const filled = await fillEventTaxRateCacheIfUnset(
    { ...(deps.reportError ? { reportError: deps.reportError } : {}) },
    deps.repos,
    prepared,
    logger,
    logContext,
  );
  if (!filled) return done("not_filled");

  const { eventIds } = await reindexAtTarget(
    prepared.cacheTarget,
    prepared.fresh.fetchedAt,
  );
  return done("filled", eventIds.length);

  // Never throws: failures are logged and reported inside.
  function reindexAtTarget(
    cacheTarget: TaxRateCacheTarget,
    now: Date,
  ): Promise<{ eventIds: string[] }> {
    return runReindexEventsAtTaxLocation(
      {
        repos: deps.repos,
        ...(deps.search ? { search: deps.search } : {}),
        clock: deps.clock,
        ...(logger ? { logger } : {}),
        ...(deps.reportError ? { reportError: deps.reportError } : {}),
      },
      cacheTarget,
      { now, useCase: "fillLocationTaxRate" },
    );
  }

  function done(
    status: FillLocationTaxRateOutput["status"],
    reindexedEventCount = 0,
  ): FillLocationTaxRateOutput {
    logger?.info("tax.location_rate_fill", {
      ...logContext,
      status,
      reindexedEventCount,
    });
    return { status, reindexedEventCount };
  }
}
