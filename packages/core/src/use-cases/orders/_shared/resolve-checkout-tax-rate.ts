import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import {
  TaxRateLookupError,
  type TaxRateLookupPort,
} from "@th/ports/tax-rate-lookup";
import { fail, isAppError } from "@th/errors";

import { isEventPast } from "../../../lib/event-ended";
import { describeError } from "../../../lib/io";
import {
  isUnknownTaxableBaseSitus,
  reportUnknownTaxableBaseSitus,
  resolveTaxableBase,
  type TaxableBase,
} from "../../../lib/pricing/taxable-base";
import {
  resolveTaxImpositions,
  type TaxImposition,
  type TaxSaleKind,
} from "../../../lib/pricing/tax-impositions";
import { applyInstructionExemption } from "../../../lib/tax/instruction-exemption";
import {
  reportLookupFailure,
  type TaxRateLookupFailure,
} from "../../events/_shared/lookup-admission-tax-rate";
import {
  eventTaxRateLocationRef,
  fillEventTaxRateCacheIfUnset,
  prepareEventTaxRate,
  resolveTaxSitusFromRef,
  taxSitusRefKey,
  type PreparedEventTaxRate,
  type TaxSitus,
} from "../../events/_shared/resolve-event-tax-rate";
import { reindexEventsAtTaxLocation } from "../../tax/reindex-events-at-tax-location";
import {
  MANUAL_EVENT_TAX_RATE_SOURCE,
  manualEventTaxRateBps,
} from "../../../lib/tax/manual-event-tax-rate";
import { markForSearchReindex } from "../../search/search-reindex-marks";

export type ResolveCheckoutTaxRateDeps = {
  taxRateLookup?: TaxRateLookupPort | null;
  clock: ClockPort;
  /** Forwarded so the swallow inside `prepareEventTaxRate` reaches Sentry. */
  reportError?: ReporterPort;
  /**
   * Test seam for the pause between tax-lookup retries
   * ({@link TAX_LOOKUP_RETRY_DELAYS_MS}). Production leaves it unset.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam for {@link TAX_LOOKUP_RETRY_BUDGET_MS}. Production leaves it
   * unset.
   */
  taxLookupBudgetMs?: number;
};

/**
 * Pauses before each RETRY of a failed tax-provider lookup in
 * {@link prepareCheckoutTax}: two retries, so three attempts at most, all
 * BEFORE the checkout's transaction opens. Short on purpose — the buyer is
 * waiting, and a provider that is down for longer than a second is better
 * met with "try again in a moment" than with a spinner.
 */
export const TAX_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [250, 750];

/**
 * WALL-CLOCK cap on {@link prepareCheckoutTax}'s lookup, every attempt and
 * pause included. One provider attempt can take ~10s on its own (ZipTax: a
 * 5s address timeout, then a 5s postal timeout), so three of them plus the
 * pauses was ~30s of spinner before the refusal in a timeout outage. With the
 * cap, an attempt still running when the budget runs out is abandoned (its
 * result ignored) and the sale is refused; a retry is only started when time
 * is left for it. Fast failures (a 108 rate-limit answer) still get both
 * retries. The postal fallback is kept on every attempt: it is what answers
 * when only the address endpoint is failing.
 */
export const TAX_LOOKUP_RETRY_BUDGET_MS = 8_000;

/** A retry is not started with less than this left of the budget. */
const TAX_LOOKUP_MIN_ATTEMPT_MS = 500;

const BUDGET_EXHAUSTED = Symbol("taxLookupBudgetExhausted");

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The minimal Event shape a checkout needs to resolve its admission tax rate.
 * All fields are columns on the Event row and are present on `EventRecord`.
 */
type CheckoutTaxRateEvent = {
  id: string;
  admissionTaxRateBps?: number | null;
  /** Source label of the publish-time stamp ("ziptax" | "ca_gst_hst" | ...). */
  taxRateSource?: string | null;
  placeId: string | null;
  savedLocationId: string | null;
  postalCode?: string | null;
  countryCode?: string | null;
  region?: string | null;
  /**
   * Organizer attestation that admission is instruction-only. When true AND
   * the resolved situs is US/TN, the admission rate is corrected to 0 /
   * "exempt:tn-instruction" — even over a stale non-zero publish-time stamp.
   */
  instructionalAdmission?: boolean | null;
  /**
   * The row version this read saw. The self-heal stamp is written only while
   * the row is still at this version (`EventsRepo.fillTaxRateIfUnset`); a
   * read without it records no self-heal at all.
   */
  updatedAt?: Date | null;
};

/**
 * The effective admission tax rate for an order at checkout, plus the frozen
 * venue jurisdiction ("situs") and the rate source that produced it. The situs
 * is snapshotted onto the Order so historical threshold rollups stay stable
 * even if the venue is later edited (spec §5.2).
 */
export type CheckoutTaxResolution = {
  /** Admission tax rate in basis points (0 when no rate resolved). */
  rateBps: number;
  /**
   * Frozen venue jurisdiction. Populated whenever a location resolved (even at
   * a 0 rate); null only when the event has no resolvable location at all.
   */
  situs: TaxSitus | null;
  /** Rate source actually used: "ziptax" | "ca_gst_hst" | ... | "none". */
  rateSource: string;
  /**
   * WHAT the rate applies to in this jurisdiction — `TICKET_FACE` (the
   * post-discount admission price only) or `BUYER_TOTAL` (everything the buyer
   * pays: face + platform fee + processing fee). Derived from the situs via
   * `resolveTaxableBase`, so every money site gets the same answer from the one
   * table. An unruled situs collecting a non-zero rate resolves to
   * `TICKET_FACE` (unchanged behaviour) and is reported to Sentry ONCE here —
   * once per order, not once per ticket line.
   */
  taxableBase: TaxableBase;
  /**
   * EVERY tax this order owes, one line each — the SALES line at `rateBps` on
   * `taxableBase`, plus any local imposition for the situs
   * (`lib/pricing/tax-impositions.ts`). THIS is what money sites charge with:
   * pass it to `solveTaxLinesAndProcessorFee`. Derived from the same situs and
   * the same (exemption-corrected) rate as the fields above, so it cannot
   * disagree with them. Empty when nothing is owed.
   */
  impositions: TaxImposition[];
};

/** A self-heal stamp for the event row, written AFTER the caller commits. */
export type CheckoutTaxSelfHeal = {
  eventId: string;
  admissionTaxRateBps: number;
  taxRateSource: string;
  /**
   * `Event.updatedAt` of the read the rate was resolved against. The write is
   * a compare-and-set on it, so a settings save committed in between (one
   * that leaves the stamp NULL included) makes the stale fill a no-op.
   */
  expectedUpdatedAt: Date;
};

/**
 * The provider's answer REPLACING a hand-entered stamp
 * (`MANUAL_EVENT_TAX_RATE_SOURCE`, owner ruling R5), written after the commit
 * by compare-and-set on the stamp the sale read. `admissionTaxRateBps: null`
 * is a "no rate here" answer: the event goes back to unstamped, as such an
 * answer leaves any event.
 */
export type ManualStampReplacement = {
  eventId: string;
  /** The manual rate the sale's read saw. */
  manualRateBps: number;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  /** `Event.updatedAt` of that read. */
  expectedUpdatedAt: Date;
  /** When the sale resolved it; stamps the search reindex mark. */
  at: Date;
};

/**
 * What `resolveCheckoutTax` leaves to do once the caller's transaction has
 * COMMITTED: the event's self-heal stamp, and the Place / SavedLocation rate
 * cache a fresh provider lookup produced. A container object, not a bare
 * `let` (TypeScript does not track an assignment made inside the transaction
 * callback — engineering standards, "Swallowing an error inside a
 * transaction", shape 1). Create one with {@link newCheckoutTaxAfterCommit},
 * pass it in, and hand it to {@link applyCheckoutTaxSelfHeal} after the
 * transaction returns. A rolled-back transaction never gets there, so
 * nothing is written for it.
 */
export type CheckoutTaxAfterCommit = {
  selfHeal: CheckoutTaxSelfHeal | null;
  locationCache: Pick<
    PreparedEventTaxRate,
    "fresh" | "cacheTarget" | "cacheAddress"
  > | null;
  /** Set instead of `selfHeal` when the rate replaces a manual stamp. */
  manualReplacement?: ManualStampReplacement | null;
};

export const newCheckoutTaxAfterCommit = (): CheckoutTaxAfterCommit => ({
  selfHeal: null,
  locationCache: null,
});

/**
 * Write what the checkout's tax resolution left — AFTER the caller's
 * transaction committed, on the full `Repos` bag (the type that carries
 * `tx`, so a transaction handle doesn't fit).
 *
 * - The event stamp is a compare-and-set (`fillTaxRateIfUnset`): it only
 *   fills a stamp that is STILL empty, on a row still at the version the
 *   rate was resolved from. This runs after the whole charge, PaymentIntent
 *   included; an unconditional write could overwrite a stamp a settings save
 *   committed meanwhile, and a NULL-only check would still fill over a save
 *   that turned instruction-only admission off and left the stamp NULL —
 *   either way every later checkout would collect the stale rate.
 * - The location cache is a compare-and-set too
 *   (`fillEventTaxRateCacheIfUnset`): only an empty cache, and only while the
 *   Place / SavedLocation still has the postal code the lookup was for, so a
 *   venue address edited meanwhile keeps its new rate.
 *
 * Best-effort and never throws: the order already committed at the right
 * rate (it lives in memory), so failing to CACHE it only means the next
 * checkout looks it up again. Failures are reported, so a permanently-failing
 * write doesn't burn a paid tax-provider call on every checkout silently.
 *
 * These used to run ON the checkout transaction inside a catch that
 * continued: a failed statement condemns a Postgres transaction, so the
 * swallow either rolled the order back silently at COMMIT or failed the next
 * statement with 25P02, blamed on the wrong line.
 */
export async function applyCheckoutTaxSelfHeal(
  deps: Pick<ResolveCheckoutTaxRateDeps, "reportError"> & { repos: Repos },
  afterCommit: CheckoutTaxAfterCommit,
  logger: LoggerPort | undefined,
): Promise<void> {
  const cache = afterCommit.locationCache;
  let filled = false;
  if (cache) {
    try {
      // Reports, then rethrows; the rethrow stops here.
      filled = await fillEventTaxRateCacheIfUnset(
        deps,
        deps.repos,
        cache,
        logger,
        { source: "checkout" },
      );
    } catch {
      // Already reported by fillEventTaxRateCacheIfUnset.
    }
  }

  const heal = afterCommit.selfHeal;
  // The venue now has a rate its other unstamped events' search documents do
  // not show ("See details"). Fire-and-forget, after the commit: the marks
  // it writes are picked up by the scheduled search drain. This event is
  // listed explicitly — the stamp below takes it out of "unstamped", but its
  // own document was built without a rate too.
  if (filled && cache?.cacheTarget && cache.fresh) {
    reindexEventsAtTaxLocation(
      { repos: deps.repos, logger, reportError: deps.reportError },
      cache.cacheTarget,
      {
        now: cache.fresh.fetchedAt,
        useCase: "checkoutTaxCacheFill",
        ...(heal ? { alsoEventIds: [heal.eventId] } : {}),
      },
    );
  }
  if (afterCommit.manualReplacement) {
    await replaceManualStamp(deps, afterCommit.manualReplacement, logger);
  }
  if (!heal) return;
  try {
    const wrote = await deps.repos.events.fillTaxRateIfUnset(heal);
    logger?.info(
      wrote
        ? "tax_rate_backfilled_at_checkout"
        : "tax_rate_backfill_skipped_row_changed",
      {
        eventId: heal.eventId,
        rateBps: heal.admissionTaxRateBps,
        source: heal.taxRateSource,
        expectedUpdatedAt: heal.expectedUpdatedAt.toISOString(),
      },
    );
  } catch (err) {
    reportTaxFault(
      deps,
      logger,
      err,
      "tax_rate_backfill_writeback_failed",
      { eventId: heal.eventId },
    );
  }
}

/**
 * The admission-tax READ a checkout does BEFORE it opens its transaction.
 *
 * Create one with {@link prepareCheckoutTax} and pass it to
 * {@link resolveCheckoutTax} inside the transaction. Opaque to callers.
 */
export type PreparedCheckoutTax = {
  /**
   * `taxSitusRefKey` of the location the rate was prepared for. Inside the
   * transaction the prepared rate is used only if the event (re-read there)
   * still resolves to this same location.
   */
  readonly refKey: string | null;
  /**
   * The prepared rate. `null` when nothing needed preparing: the event was
   * stamped (the in-tx fast path needs no lookup), has no location, or was
   * not found (the in-tx read refuses it).
   */
  readonly prepared: PreparedEventTaxRate | null;
};

export type PrepareCheckoutTaxOptions = {
  /**
   * Which refusal gates the transaction applies. `"primary"` (default) is the
   * ticket sale, which refuses an unpublished event. `"resale"` is
   * holder-to-holder and does not look at the status. (RSVP and an ended
   * event are refused by both.)
   *
   * Same concept as `resolveCheckoutTax`'s `options.sale` (`TaxSaleKind`,
   * "PRIMARY" | "RESALE"), spelled lowercase for historical reasons. Not
   * unified yet: test files are outside the typecheck, so a stray lowercase
   * "resale" left in a test would silently become a primary sale. Unify both
   * on `TaxSaleKind` in one change that greps every call site.
   */
  sale?: "primary" | "resale";
};

const NOTHING_PREPARED: PreparedCheckoutTax = { refKey: null, prepared: null };

/**
 * Do the slow half of a checkout's tax resolution BEFORE the transaction:
 * read the event and, when it was never stamped, run `prepareEventTaxRate` —
 * which on a cache miss calls the tax provider (ZipTax: live HTTP, up to 5s).
 * That call used to run inside the hold / charge / resale transactions,
 * holding row locks and a pooled connection across a third-party round trip
 * (the event save moved its own lookup out for the same reason, spec
 * 2026-09-05 P-1).
 *
 * Reads only, on the non-transaction repos. A repo fault is reported and
 * RETHROWN, never priced at $0.
 *
 * A FAILED provider lookup (rate limited, bad key, timeout, HTTP error) is
 * RETRIED here, up to two more times with a short pause
 * ({@link TAX_LOOKUP_RETRY_DELAYS_MS}), all within an ~8s wall-clock budget
 * ({@link TAX_LOOKUP_RETRY_BUDGET_MS}) — never inside the transaction. When
 * every attempt failed the sale is REFUSED with `TAX_RATE_UNAVAILABLE`
 * (retryable; the buyer reads "We couldn't calculate tax — please try again
 * in a moment") and reported ONCE: no order is created and no seat is held,
 * because this runs before the transaction. Owner ruling 2026-10-06: never
 * charge 0% because a lookup failed. It used to: a failed lookup read as "no
 * rate" and the order was priced at 0.
 *
 * A GENUINE no-rate outcome still prices at 0, as before: the event has no
 * location, the provider answered "no rate here" (a non-US address), an
 * unsupported Canadian province, or the provider SUCCESSFULLY returned 0.
 * So does a deployment with no provider configured (local dev): nothing was
 * looked up, so nothing failed.
 *
 * Inside the transaction, {@link resolveCheckoutTax} re-reads the event and
 * uses this result only when the event is still unstamped and still at the
 * same location. A stamp is always preferred, and a location that changed in
 * between (a race measured in milliseconds) is resolved again in the
 * transaction rather than charged at the wrong venue's rate.
 *
 * A HAND-ENTERED stamp (`MANUAL_EVENT_TAX_RATE_SOURCE`, owner ruling R5) is
 * the one stamp still looked up: once, with no retry, inside
 * {@link MANUAL_STAMP_RELOOKUP_BUDGET_MS}. An answer — a rate, or "no rate
 * here" — is charged and replaces the manual stamp after the commit; a
 * failure keeps the manual rate for this sale (reported, never refused,
 * never 0%). `manualStamp: "keep"` skips that lookup (the hold quote).
 */
export async function prepareCheckoutTax(
  deps: ResolveCheckoutTaxRateDeps & { repos: Repos },
  eventId: string,
  logger: LoggerPort | undefined,
  options: PrepareCheckoutTaxOptions &
    PrepareCheckoutTaxChannelOption &
    PrepareCheckoutTaxManualStampOption = {},
): Promise<PreparedCheckoutTax> {
  const sale = options.sale ?? "primary";
  const channel = options.channel ?? "online";
  const event = await deps.repos.events.getById(eventId);
  // A stamp needs no lookup — except a hand-entered one, which the provider's
  // next answer replaces (owner ruling R5; `prepareOverManualStamp` below).
  const manualRateBps = event ? manualEventTaxRateBps(event) : null;
  if (!event || (event.admissionTaxRateBps != null && manualRateBps == null)) {
    return NOTHING_PREPARED;
  }
  // Never spend a paid provider call on a checkout the transaction is about
  // to refuse: nothing would be cached, so every retry would pay again. A
  // wrong skip costs nothing but latency — the transaction resolves the rate
  // itself when nothing fits.
  //
  // An unpublished event is refused for a primary sale only: resale does not
  // look at the status (create-resale-checkout), and neither does the door's
  // transaction, so a door sale is not skipped here either (NFR-002).
  if (
    sale === "primary" &&
    channel !== "door" &&
    event.status !== "PUBLISHED"
  ) {
    return NOTHING_PREPARED;
  }
  if (event.attendanceMode === "RSVP") {
    return NOTHING_PREPARED;
  }
  // Sales close when the event ends (`ensureEventOnSale` for a ticket sale,
  // the `isEventPast` gate in create-resale-checkout for a resale).
  // NOT for a door sale: the door sells after the start (and an event with no
  // `endsAt` counts as ended once it starts), and its transaction applies no
  // event-level close, so skipping here would push the lookup into the sale's
  // transaction (spec 2026-10-07 FR-006, NFR-002).
  if (channel !== "door" && isEventPast(event, deps.clock.now())) {
    return NOTHING_PREPARED;
  }
  const ref = eventTaxRateLocationRef(event);
  if (!ref) {
    return NOTHING_PREPARED;
  }
  if (manualRateBps != null) {
    if (options.manualStamp === "keep") return NOTHING_PREPARED;
    return prepareOverManualStamp(deps, event.id, ref, manualRateBps, logger);
  }
  const sleep = deps.sleep ?? defaultSleep;
  const budgetMs = deps.taxLookupBudgetMs ?? TAX_LOOKUP_RETRY_BUDGET_MS;
  // Real elapsed time, not `deps.clock` (a frozen clock in tests, and the
  // budget is about how long the buyer waits).
  const startedAt = Date.now();
  const remainingMs = () => budgetMs - (Date.now() - startedAt);
  let prepared: PreparedEventTaxRate;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    let outcome: PreparedEventTaxRate | typeof BUDGET_EXHAUSTED;
    try {
      outcome = await withinBudget(
        prepareEventTaxRate(
          {
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            reportError: deps.reportError,
          },
          deps.repos,
          ref,
          logger,
          { eventId: event.id, source: "checkout", attempt: attempts },
          // Reported once below, with the attempt count — not once per try.
          { reportLookupFailure: false },
        ),
        remainingMs(),
      );
    } catch (err) {
      // Same report the in-transaction path gives this fault, then rethrown —
      // see the catch in `resolveCheckoutTax`.
      reportTaxFault(deps, logger, err, "tax_rate_checkout_resolution_failed", {
        eventId: event.id,
      });
      throw err;
    }
    if (outcome === BUDGET_EXHAUSTED) {
      refuseUnknownTaxRate(
        deps,
        logger,
        {
          providerCode: null,
          httpStatus: null,
          error: new TaxRateLookupError(
            `tax-rate lookup still running after the ${budgetMs}ms checkout budget`,
          ),
        },
        { eventId: event.id, attempts, stage: "prepare", budgetExhausted: true },
      );
    }
    prepared = outcome;
    if (prepared.unknown?.reason !== "lookup_failed") break;
    const delay = TAX_LOOKUP_RETRY_DELAYS_MS[attempts - 1];
    if (
      delay === undefined ||
      remainingMs() - delay < TAX_LOOKUP_MIN_ATTEMPT_MS
    ) {
      refuseUnknownTaxRate(deps, logger, prepared.unknown.failure, {
        eventId: event.id,
        attempts,
        stage: "prepare",
      });
    }
    await sleep(delay);
  }
  if (attempts > 1) {
    logger?.info("tax_rate_lookup_recovered_on_retry", {
      eventId: event.id,
      attempts,
    });
  }
  return { refKey: taxSitusRefKey(ref), prepared };
}

/**
 * Which surface is selling. `"online"` (default) is checkout, hold and
 * resale. `"door"` is a POS sale at the event (spec 2026-10-07 FR-006). It
 * skips the two shortcuts its transaction does not mirror: the event-ended
 * one (door sales happen after the start) and the unpublished one (the door
 * applies no event-status gate). Skipping a sale the transaction then makes
 * would move the lookup inside it (NFR-002). The RSVP gate, and the
 * retry-then-refuse rule, are the same.
 */
/**
 * What a sale does over a hand-entered stamp. `"relookup"` (default) asks the
 * provider once, so its answer can replace the stamp (owner ruling R5).
 * `"keep"` charges the stamp without asking: the hold quote
 * (`updateOrderItems`), which runs on every cart change and is display-only
 * — `createCheckout` re-resolves at the charge. Without it one purchase in an
 * outage would wait the relookup budget, and report, once per cart edit.
 */
export type PrepareCheckoutTaxManualStampOption = {
  manualStamp?: "relookup" | "keep";
};

export type PrepareCheckoutTaxChannelOption = {
  channel?: "online" | "door";
};

/**
 * `work`, or {@link BUDGET_EXHAUSTED} when it has not settled within `ms`.
 * The abandoned promise keeps running (a provider call cannot be cancelled
 * through the port); its result, or its rejection, is dropped.
 */
async function withinBudget<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof BUDGET_EXHAUSTED> {
  if (ms <= 0) {
    work.catch(() => {});
    return BUDGET_EXHAUSTED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof BUDGET_EXHAUSTED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_EXHAUSTED), ms);
  });
  try {
    const result = await Promise.race([work, timeout]);
    // A late rejection of abandoned work must not surface as unhandled.
    if (result === BUDGET_EXHAUSTED) work.catch(() => {});
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Wall-clock cap on the lookup a sale runs over a HAND-ENTERED stamp, and on
 * the one `setManualEventTaxRate` runs before it lets a person enter a rate.
 * Short, and one attempt only: the sale has a rate to charge either way, so
 * the buyer (often at the door, in a queue) waits at most this long for the
 * provider to come back, and a provider still down costs every sale no more
 * than this until it does.
 */
export const MANUAL_STAMP_RELOOKUP_BUDGET_MS = 2_000;

/**
 * One attempt to resolve an event location's rate, no retry, within
 * `budgetCapMs` (default {@link MANUAL_STAMP_RELOOKUP_BUDGET_MS}; manual
 * entry passes the sale's {@link TAX_LOOKUP_RETRY_BUDGET_MS}, so a provider
 * slow enough to time out the gate would also have failed a sale) — the
 * same read a sale does:
 * the Place / SavedLocation cache first, the Canada table, then the provider.
 *
 * - `answered`: a rate, or a definitive "no rate here" (`prepared.stamp`
 *   null with no `unknown`).
 * - `failed`: the provider failed, or was still running at the budget.
 * - `not_looked_up`: no provider is configured, so nothing was asked.
 *
 * Nothing is reported here: each caller decides what the outcome means. A
 * repo fault is reported and rethrown, as on the main checkout path.
 */
export type ManualTaxRateProbe =
  | { kind: "answered"; prepared: PreparedEventTaxRate }
  | {
      kind: "failed";
      failure: TaxRateLookupFailure;
      budgetExhausted: boolean;
    }
  | { kind: "not_looked_up" };

export async function probeEventTaxRateOnce(
  deps: ResolveCheckoutTaxRateDeps & { repos: Repos },
  ref: NonNullable<ReturnType<typeof eventTaxRateLocationRef>>,
  eventId: string,
  logger: LoggerPort | undefined,
  source: string,
  budgetCapMs: number = MANUAL_STAMP_RELOOKUP_BUDGET_MS,
): Promise<ManualTaxRateProbe> {
  const budgetMs = Math.min(deps.taxLookupBudgetMs ?? budgetCapMs, budgetCapMs);
  let outcome: PreparedEventTaxRate | typeof BUDGET_EXHAUSTED;
  try {
    outcome = await withinBudget(
      prepareEventTaxRate(
        {
          taxRateLookup: deps.taxRateLookup,
          clock: deps.clock,
          reportError: deps.reportError,
        },
        deps.repos,
        ref,
        logger,
        { eventId, source, attempt: 1 },
        // The caller reports the outcome it acts on.
        { reportLookupFailure: false },
      ),
      budgetMs,
    );
  } catch (err) {
    reportTaxFault(deps, logger, err, "tax_rate_checkout_resolution_failed", {
      eventId,
    });
    throw err;
  }
  if (outcome === BUDGET_EXHAUSTED) {
    return {
      kind: "failed",
      budgetExhausted: true,
      failure: {
        providerCode: null,
        httpStatus: null,
        error: new TaxRateLookupError(
          `tax-rate lookup still running after the ${budgetMs}ms manual-rate budget`,
        ),
      },
    };
  }
  if (outcome.unknown?.reason === "lookup_failed") {
    return {
      kind: "failed",
      budgetExhausted: false,
      failure: outcome.unknown.failure,
    };
  }
  if (outcome.unknown?.reason === "not_looked_up") {
    return { kind: "not_looked_up" };
  }
  return { kind: "answered", prepared: outcome };
}

/**
 * The lookup over a hand-entered stamp (owner ruling R5: "a later successful
 * lookup replaces it"). An ANSWER — a rate, or a definitive "no rate here" —
 * is returned prepared; `resolveCheckoutTax` charges it and records the
 * replacement for after the commit. Since a person may enter a rate only
 * while the lookup is failing (`setManualEventTaxRate`), any answer means the
 * reason for the manual rate is gone.
 *
 * Otherwise {@link NOTHING_PREPARED}, and the sale charges the manual stamp:
 * - a FAILED lookup, or one still running at the budget: reported (that is
 *   the swallow), never refused — the manual rate exists for exactly this;
 * - nothing looked up (no provider configured): nothing to replace it with.
 */
async function prepareOverManualStamp(
  deps: ResolveCheckoutTaxRateDeps & { repos: Repos },
  eventId: string,
  ref: NonNullable<ReturnType<typeof eventTaxRateLocationRef>>,
  manualRateBps: number,
  logger: LoggerPort | undefined,
): Promise<PreparedCheckoutTax> {
  const probe = await probeEventTaxRateOnce(
    deps,
    ref,
    eventId,
    logger,
    "checkout",
  );
  if (probe.kind === "failed") {
    // The deliberate swallow: the sale goes on at the manual rate.
    reportLookupFailure(
      { reportError: deps.reportError, logger },
      probe.failure,
      {
        eventId,
        manualRateBps,
        budgetExhausted: probe.budgetExhausted,
        kept: "manual_rate",
      },
      "checkoutManualTaxRateKept",
    );
    return NOTHING_PREPARED;
  }
  if (probe.kind === "not_looked_up") return NOTHING_PREPARED;
  return { refKey: taxSitusRefKey(ref), prepared: probe.prepared };
}

/**
 * Whether `resolveCheckoutTax` charges the PREPARED answer over the event's
 * stamp: only when the stamp the transaction read is (still) hand-entered,
 * only when the prepare got an answer, and only for the location the event
 * still points at. Otherwise the stamp is charged — a manual stamp is never
 * re-resolved on the transaction (NFR-002).
 */
function preparedReplacesManualStamp(
  event: CheckoutTaxRateEvent,
  ref: ReturnType<typeof eventTaxRateLocationRef>,
  preparedTax: PreparedCheckoutTax | undefined,
): boolean {
  return (
    manualEventTaxRateBps(event) != null &&
    preparedTax?.prepared != null &&
    preparedTax.prepared.unknown == null &&
    ref != null &&
    preparedTax.refKey === taxSitusRefKey(ref)
  );
}

/**
 * Record the replacement of the manual stamp the transaction read, for
 * {@link applyCheckoutTaxSelfHeal}. A read without a row version cannot be
 * compared-and-set: reported, and the next sale tries again.
 */
function recordManualReplacement(
  deps: ResolveCheckoutTaxRateDeps,
  logger: LoggerPort | undefined,
  afterCommit: CheckoutTaxAfterCommit | undefined,
  event: CheckoutTaxRateEvent,
  manualRateBps: number,
  replacement: { admissionTaxRateBps: number | null; taxRateSource: string | null },
): void {
  if (!afterCommit) return;
  if (!(event.updatedAt instanceof Date)) {
    reportTaxFault(
      deps,
      logger,
      new Error("event read without updatedAt: manual tax rate kept"),
      "tax_rate_manual_replace_skipped_no_row_version",
      { eventId: event.id },
    );
    return;
  }
  afterCommit.manualReplacement = {
    eventId: event.id,
    manualRateBps,
    ...replacement,
    expectedUpdatedAt: event.updatedAt,
    at: deps.clock.now(),
  };
}

/**
 * After the commit: the provider's answer replaces the hand-entered stamp the
 * sale read — by compare-and-set, so concurrent sales replace it once — and
 * the event is marked for a search reindex in the same transaction (listing
 * cards quote an all-in price built from the event's rate). A CHARGED rate
 * that differs from the manual one ("no rate here" charges 0) is reported to
 * the platform (owner ruling R5: "second alert if the rates differ"); the
 * same rate is only logged. Never throws, as the rest of
 * {@link applyCheckoutTaxSelfHeal}.
 */
async function replaceManualStamp(
  deps: Pick<ResolveCheckoutTaxRateDeps, "reportError"> & { repos: Repos },
  r: ManualStampReplacement,
  logger: LoggerPort | undefined,
): Promise<void> {
  let wrote: boolean;
  try {
    wrote = await deps.repos.tx(async (tx) => {
      const replaced = await tx.events.replaceTaxRateIfUnchanged({
        eventId: r.eventId,
        expected: {
          admissionTaxRateBps: r.manualRateBps,
          taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE,
          updatedAt: r.expectedUpdatedAt,
        },
        admissionTaxRateBps: r.admissionTaxRateBps,
        taxRateSource: r.taxRateSource,
      });
      if (replaced) {
        await markForSearchReindex(tx, [{ kind: "event", id: r.eventId }], r.at);
      }
      return replaced;
    });
  } catch (err) {
    reportTaxFault(deps, logger, err, "tax_rate_manual_replace_failed", {
      eventId: r.eventId,
    });
    return;
  }
  const extra = {
    eventId: r.eventId,
    manualRateBps: r.manualRateBps,
    lookedUpRateBps: r.admissionTaxRateBps,
    lookedUpSource: r.taxRateSource,
  };
  if (!wrote) {
    logger?.info("tax_rate_manual_replace_skipped_row_changed", extra);
    return;
  }
  logger?.info("tax_rate_manual_replaced_by_lookup", extra);
  if ((r.admissionTaxRateBps ?? 0) === r.manualRateBps) return;
  try {
    deps.reportError?.(new Error("manual_tax_rate_replaced_differs"), {
      tags: {
        area: "tax",
        kind: "manual_rate_replaced_differs",
        useCase: "resolveCheckoutTax",
      },
      extra,
    });
  } catch {
    // A throwing reporter must never change the outcome.
  }
  // `warn`: the report above is what reaches Sentry; this is the log trail.
  logger?.warn("tax_rate_manual_replaced_rate_differs", extra);
}

/**
 * Refuse the sale: the venue's rate is UNKNOWN because the tax-provider lookup
 * failed. Reported here (guarded) because `TAX_RATE_UNAVAILABLE` maps to a 503,
 * which the 500-only Sentry backstop does not capture; then thrown as the
 * retryable domain error the buyer sees as "We couldn't calculate tax —
 * please try again in a moment".
 */
function refuseUnknownTaxRate(
  deps: Pick<ResolveCheckoutTaxRateDeps, "reportError">,
  logger: LoggerPort | undefined,
  failure: TaxRateLookupFailure,
  extra: Record<string, unknown>,
): never {
  reportLookupFailure(
    { reportError: deps.reportError, logger },
    failure,
    extra,
    "checkoutTaxRateUnavailable",
  );
  throw fail("TAX_RATE_UNAVAILABLE", { cause: failure.error });
}

/**
 * Resolve both the checkout tax rate and the venue situs snapshot in one pass.
 *
 * Uses the publish-time stamp when present (the common, zero-overhead path);
 * otherwise uses the last-chance lookup `prepareCheckoutTax` ran BEFORE the
 * transaction (ZipTax for US, the static Canada map for CA). Only when no
 * prepared result fits — none was passed (the seed pricing path, older
 * tests), or the event's location changed between the two reads — does it
 * fall back to `prepareEventTaxRate` here, on the transaction. NOTHING is
 * written here: the event's self-heal stamp and the location's rate cache
 * are recorded on `afterCommit` for the caller to write after its
 * transaction commits ({@link applyCheckoutTaxSelfHeal}). No container → no
 * write-back at all (the seed pricing path).
 *
 * A FAILED provider lookup on that in-transaction fallback is not retried
 * (a retry would hold the transaction open across more provider round
 * trips): the sale is refused with `TAX_RATE_UNAVAILABLE`, exactly as
 * {@link prepareCheckoutTax} refuses after its retries. Never priced at 0.
 *
 * The situs is derived from the SAME venue-precedence location that resolved
 * the rate (Place → SavedLocation → inline), never from the buyer's billing
 * address.
 *
 * `options.sale` (default PRIMARY) selects which local impositions apply: a
 * RESALE drops rules with `appliesToResale: false` (see `tax-impositions.ts`).
 * The rate, situs and SALES line are the same either way.
 */
export async function resolveCheckoutTax(
  deps: ResolveCheckoutTaxRateDeps,
  tx: TxRepos,
  event: CheckoutTaxRateEvent,
  logger: LoggerPort | undefined,
  afterCommit?: CheckoutTaxAfterCommit,
  preparedTax?: PreparedCheckoutTax,
  options?: { sale?: TaxSaleKind },
): Promise<CheckoutTaxResolution> {
  const ref = eventTaxRateLocationRef(event);
  const sale = options?.sale ?? "PRIMARY";

  // Common path: the event was stamped at publish time — zero overhead for the
  // rate. Still resolve the situs from the location so the order carries a
  // frozen jurisdiction even when the rate came from the cached stamp.
  if (
    event.admissionTaxRateBps != null &&
    !preparedReplacesManualStamp(event, ref, preparedTax)
  ) {
    const situs = await resolveSitusOnly(deps, tx, ref, logger, event.id);
    // Prefer the stamped source. Fall back to "none" only when the stamp is a
    // 0 rate with no recorded source (nothing was actually collected).
    const rateSource =
      event.taxRateSource ??
      (event.admissionTaxRateBps > 0 ? "unknown" : "none");
    // TN instruction-only exemption applied to the STAMPED rate: an organizer
    // who toggles instructionalAdmission on after publish (without re-saving)
    // leaves a stale non-zero stamp — correct it to 0 / "exempt:tn-instruction"
    // here so the buyer is never charged TN admission tax on instruction.
    // No-op outside TN or when the flag is off.
    const exempt = applyInstructionExemption({
      instructionalAdmission: event.instructionalAdmission,
      situs,
      rateBps: event.admissionTaxRateBps,
      source: rateSource,
    });
    return withTaxableBase(deps, logger, event.id, sale, {
      rateBps: exempt.rateBps,
      situs,
      rateSource: exempt.source,
    });
  }

  try {
    // The READ half only — normally already done before the transaction
    // (`prepareCheckoutTax`), so no tax-provider call holds this
    // transaction open. The location cache a fresh lookup produced is
    // written after the commit (`applyCheckoutTaxSelfHeal`), never on this
    // transaction.
    const preparedFits =
      preparedTax?.prepared != null &&
      ref != null &&
      preparedTax.refKey === taxSitusRefKey(ref);
    if (preparedTax && !preparedFits && ref) {
      // Nothing prepared fits: the event moved or lost its stamp between the
      // pre-transaction read and this one, or `prepareCheckoutTax` skipped it
      // (it looked unsellable then). Resolve again here rather than charge
      // the old venue's rate: correct, at the cost of the lookup running on
      // the transaction for this one rare order.
      logger?.warn("tax_rate_prepared_stale_resolving_in_tx", {
        eventId: event.id,
        preparedRefKey: preparedTax.refKey,
        refKey: taxSitusRefKey(ref),
      });
    }
    const prepared =
      preparedFits && preparedTax?.prepared
        ? preparedTax.prepared
        : await prepareEventTaxRate(
            {
              taxRateLookup: deps.taxRateLookup,
              clock: deps.clock,
              reportError: deps.reportError,
            },
            tx,
            ref,
            logger,
            { eventId: event.id, source: "checkout" },
            // A failure is refused (and reported once) just below.
            { reportLookupFailure: false },
          );
    if (prepared.unknown?.reason === "lookup_failed") {
      refuseUnknownTaxRate(deps, logger, prepared.unknown.failure, {
        eventId: event.id,
        attempts: 1,
        stage: "transaction",
      });
    }
    if (afterCommit && prepared.fresh && prepared.cacheTarget) {
      afterCommit.locationCache = {
        fresh: prepared.fresh,
        cacheTarget: prepared.cacheTarget,
        cacheAddress: prepared.cacheAddress ?? null,
      };
    }
    const resolved = prepared.stamp;
    // Only reached over a hand-entered stamp when `preparedReplacesManualStamp`
    // held: the answer REPLACES it after the commit (owner ruling R5). A
    // "no rate here" answer unstamps the event, as it leaves any other.
    const replacingManualBps = manualEventTaxRateBps(event);
    if (replacingManualBps != null && !resolved) {
      recordManualReplacement(deps, logger, afterCommit, event, replacingManualBps, {
        admissionTaxRateBps: null,
        taxRateSource: null,
      });
    }

    if (!resolved) {
      // No location, no provider configured, a non-US jurisdiction, or a
      // provider that answered "no rate here": a GENUINE no-rate outcome,
      // priced at 0. (A FAILED lookup never gets here — refused above.)
      // Best-effort situs so the order still carries a jurisdiction if it has
      // a resolvable location (e.g. an unsupported CA province still stamps).
      const situs = await resolveSitusOnly(deps, tx, ref, logger, event.id);
      return withTaxableBase(deps, logger, event.id, sale, {
        rateBps: 0,
        situs,
        rateSource: "none",
      });
    }

    // TN instruction-only exemption applied to the freshly-resolved rate: when
    // the event is flagged instructional AND the resolved situs is US/TN, zero
    // the rate (source "exempt:tn-instruction") before stamping so the
    // self-heal write persists the exempt rate too. No-op elsewhere.
    const exempt = applyInstructionExemption({
      instructionalAdmission: event.instructionalAdmission,
      situs: resolved.situs,
      rateBps: resolved.rateBps,
      source: resolved.source,
    });

    // Self-heal: stamp the freshly-resolved rate onto the event so subsequent
    // checkouts skip the lookup entirely — RECORDED here, written by the
    // caller after its transaction commits (`applyCheckoutTaxSelfHeal`). A
    // failure to persist the stamp can then neither downgrade this order nor
    // condemn its transaction.
    const rate = exempt.rateBps;
    if (replacingManualBps != null) {
      recordManualReplacement(deps, logger, afterCommit, event, replacingManualBps, {
        admissionTaxRateBps: rate,
        taxRateSource: exempt.source,
      });
    } else if (afterCommit) {
      if (event.updatedAt instanceof Date) {
        afterCommit.selfHeal = {
          eventId: event.id,
          admissionTaxRateBps: rate,
          taxRateSource: exempt.source,
          // The version of THIS read: its `instructionalAdmission` decided
          // the exemption above and its location decided the rate.
          expectedUpdatedAt: event.updatedAt,
        };
      } else {
        // No version to compare against → no safe compare-and-set, so no
        // stamp, and the next checkout pays for the provider lookup again —
        // for ever, if a caller keeps handing us a read without `updatedAt`.
        // A bug in the caller, never a normal path: `logger.error` plus a
        // report, so it is visible instead of a silent `info`.
        reportTaxFault(
          deps,
          logger,
          new Error("event read without updatedAt: tax self-heal disabled"),
          "tax_rate_backfill_skipped_no_row_version",
          { eventId: event.id },
        );
      }
    }

    return withTaxableBase(deps, logger, event.id, sale, {
      rateBps: rate,
      situs: resolved.situs,
      rateSource: exempt.source,
    });
  } catch (err) {
    // The refusal above is a domain error, already reported: let it through
    // as is.
    if (isAppError(err) && err.code === "TAX_RATE_UNAVAILABLE") throw err;
    // RETHROWS. It used to return `{ rateBps: 0, situs: null }`, and that zero
    // was written to `orders.createPending` and funded the PaymentIntent — a
    // $40 ticket committing at $0 tax with the platform as merchant of record,
    // logged at `warn` (which the Sentry pino integration does not capture), so
    // invisible. "Never block checkout" is the right instinct for a tax-provider
    // outage; it is not a licence to charge the wrong price.
    //
    // Nothing legitimate is lost. Every tolerant case is already handled
    // BELOW this catch: `prepareEventTaxRate` turns a provider failure into
    // `unknown` (refused above), the not-found paths return null without throwing,
    // and both write-backs (event stamp, location cache) run after the commit.
    // What reaches here is an unexpected fault
    // — overwhelmingly a database one, which inside this transaction has
    // already condemned it, so swallowing only delays a failure that is coming
    // anyway and corrupts the price on the way.
    reportTaxFault(deps, logger, err, "tax_rate_checkout_resolution_failed", {
      eventId: event.id,
    });
    throw err;
  }
}

// A bps-only wrapper used to live here ("retained for callers that don't need
// the situs snapshot"). It is DELETED, not deprecated: its last two callers
// (update-order-items, create-resale-checkout) now need the situs, because the
// situs decides the TAXABLE BASE as well as the rate. A helper that returns the
// rate and silently drops the base is the exact shape of the next
// under-collection — the whole point of this change is that a money site cannot
// get a rate without also getting what the rate applies to. Every caller uses
// `resolveCheckoutTax`.

/**
 * A tax fault reaches Sentry explicitly, and logs at `error`.
 *
 * Every one of the three call sites used to log at `warn` and return a degraded
 * value. `warn` is NOT captured by the Sentry pino integration, so those
 * failures were invisible — the same shape as the Jun 2026 silent search
 * outage, sitting on the checkout path. The reporter call is guarded so a
 * throwing reporter cannot manufacture a new failure out of the one being
 * reported.
 */
function reportTaxFault(
  deps: Pick<ResolveCheckoutTaxRateDeps, "reportError">,
  logger: LoggerPort | undefined,
  err: unknown,
  event: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: "resolveCheckoutTax" },
      extra: { ...extra, event },
    });
  } catch {
    // ignored on purpose
  }
  logger?.error(event, { ...extra, error: describeError(err) });
}

/**
 * Resolve ONLY the venue situs (no rate lookup, no cache write-back) from the
 * event's location precedence. Used when the rate is already known (publish
 * stamp) or when no rate resolved but we still want to freeze the jurisdiction.
 * A missing location yields null; a repo fault is reported and rethrown.
 */
async function resolveSitusOnly(
  deps: ResolveCheckoutTaxRateDeps,
  tx: TxRepos,
  ref: ReturnType<typeof eventTaxRateLocationRef>,
  logger: LoggerPort | undefined,
  eventId: string,
): Promise<TaxSitus | null> {
  if (!ref) return null;
  try {
    // ONE normalisation, shared with the publish/rate path — see
    // `normalizeTaxSitus`. A situs that differs by case between the two would
    // silently miss the taxable-base table and under-collect.
    return await resolveTaxSitusFromRef(tx, ref);
  } catch (err) {
    // RETHROWS. `resolveTaxSitusFromRef` returns null for every legitimate
    // miss and throws only on a repo fault — a failed read on the caller's
    // TRANSACTION, which that failure has already condemned. Swallowing it
    // here turned the order's next statement into a 25P02 blamed on the
    // wrong line (or, with nothing after it, a silent rollback at COMMIT),
    // and stamped a null situs that keeps the order out of the
    // economic-nexus rollup. Reported, then propagated.
    reportTaxFault(deps, logger, err, "tax_situs_resolution_failed", {
      eventId,
    });
    throw err;
  }
}

/**
 * Attach the jurisdictional taxable base to a resolved rate, and shout when the
 * jurisdiction has no ruling behind it.
 *
 * The report is a DELIBERATE SWALLOW in the CLAUDE.md sense: we keep charging
 * `TICKET_FACE` (today's behaviour — an unruled jurisdiction must not silently
 * reprice a live order) and carry on, so the gap has to reach Sentry explicitly
 * or it is invisible. Called on every exit of `resolveCheckoutTax`, which runs
 * exactly once per order, so the report is once per order too.
 */
function withTaxableBase(
  deps: ResolveCheckoutTaxRateDeps,
  logger: LoggerPort | undefined,
  eventId: string,
  sale: TaxSaleKind,
  resolution: Omit<CheckoutTaxResolution, "taxableBase" | "impositions">,
): CheckoutTaxResolution {
  const { situs, rateBps } = resolution;
  if (isUnknownTaxableBaseSitus(situs, rateBps)) {
    reportUnknownTaxableBaseSitus(deps.reportError, {
      situs,
      rateBps,
      extra: { eventId, useCase: "resolveCheckoutTax" },
    });
    // `warn`, not `error`: the reporter call above is what guarantees Sentry
    // visibility (and groups one issue per jurisdiction). Logging at `error`
    // too would duplicate every one of those issues through the pino
    // integration. This line exists for the local/Cloud Run log trail.
    logger?.warn("tax_taxable_base_situs_unruled", {
      eventId,
      rateBps,
      countryCode: situs?.countryCode ?? null,
      region: situs?.region ?? null,
    });
  }
  return {
    ...resolution,
    taxableBase: resolveTaxableBase(situs),
    impositions: resolveTaxImpositions({
      situs,
      salesTaxRateBps: rateBps,
      sale,
    }),
  };
}
