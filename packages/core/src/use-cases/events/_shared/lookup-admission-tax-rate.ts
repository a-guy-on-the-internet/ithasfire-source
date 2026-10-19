import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import {
  isTaxRateLookupError,
  type TaxRateLookupPort,
} from "@th/ports/tax-rate-lookup";
import { describeError } from "../../../lib/io";

/**
 * Result of a cached admission tax-rate lookup.
 */
export interface AdmissionTaxRateResult {
  /** Combined admission tax rate in basis points (e.g. 975 = 9.75%). */
  rateBps: number;
  /** Source label for audit ("ziptax", "manual", etc.). */
  source: string;
  /** When the rate was fetched (from the injected clock). */
  fetchedAt: Date;
}

/**
 * Why a lookup FAILED — the rate is unknown, and must never be read as 0.
 * Built from the provider's `TaxRateLookupError` when it threw one (ZipTax:
 * `providerCode` 108 = rate limit, 101 = bad key), otherwise from whatever
 * else the call threw.
 */
export interface TaxRateLookupFailure {
  /** The provider's own response code, when it sent one. */
  providerCode: number | null;
  /** HTTP status of a failed provider call, when there was one. */
  httpStatus: number | null;
  /** The thrown error, for reporting. */
  error: unknown;
}

/**
 * The FOUR outcomes of {@link lookupAdmissionTaxRateOutcome}:
 *  - `rate` — the provider answered with a rate (a real 0 included);
 *  - `none` — the provider answered: no rate for this place (non-US,
 *    an unresolvable postal code / address);
 *  - `skipped` — no lookup was made: no provider configured, or no postal
 *    code / country to look up. The rate is not known;
 *  - `failed` — the lookup failed. The rate is UNKNOWN.
 */
export type AdmissionTaxRateLookupOutcome =
  | { kind: "rate"; result: AdmissionTaxRateResult }
  | { kind: "none" }
  | { kind: "skipped" }
  | { kind: "failed"; failure: TaxRateLookupFailure };

export interface LookupAdmissionTaxRateParams {
  /** Tax provider port. When absent, the lookup is skipped (returns null). */
  taxRateLookup: TaxRateLookupPort | null | undefined;
  /** Postal code of the location. Required for a lookup. */
  postalCode: string | null | undefined;
  /** Two-letter country code. Required for a lookup ("US" currently). */
  countryCode: string | null | undefined;
  /**
   * The street address, when the location has one. The provider prefers a
   * street-address lookup (rooftop-level: city limits, special districts)
   * and falls back to the postal code. Optional: an inline event address has
   * no street.
   */
  address?: {
    street: string | null | undefined;
    city: string | null | undefined;
    region: string | null | undefined;
  } | null;
  /** Clock used to stamp `fetchedAt`. */
  clock: ClockPort;
  logger?: LoggerPort;
  /** Optional structured context merged into log lines (e.g. the location id). */
  logContext?: Record<string, unknown>;
  /**
   * Error tracker for the deliberate swallow below. A throwing provider is
   * caught and turned into `null`; before this was threaded the failure only
   * reached a `logger.warn`, which the Sentry pino integration does not
   * capture — a provider outage was invisible. Optional so the seed scripts
   * and older callers keep working; production callers thread it.
   */
  reportError?: ReporterPort;
  /**
   * Default true. False = a FAILED lookup is returned without being reported
   * or logged: the caller retries and reports the final outcome itself
   * (checkout's `prepareCheckoutTax`), so one refusal is one Sentry event,
   * not one per attempt.
   */
  reportFailure?: boolean;
}

/**
 * Look up the admission tax rate for a location and return a cache-ready
 * result, or `null` when the rate could not be resolved.
 *
 * This centralizes the freeform-SavedLocation lookup so SavedLocation, Place,
 * and the publish-time resolver all behave identically:
 *
 *  - No-op (returns null) when the provider is absent or postal/country is
 *    missing.
 *  - Non-fatal on error — reports the failure, logs, and returns null rather
 *    than throwing. A caller that must tell a FAILED lookup from "no rate
 *    here" (checkout, the quote) uses {@link lookupAdmissionTaxRateOutcome}.
 *
 * Callers are responsible for persisting the result (e.g. via
 * `repos.savedLocations.updateTaxRate` / `repos.places.updateTaxRate`).
 *
 * This is a live HTTP call in production (ZipTax, 5s timeout). Callers that
 * hold a database transaction MUST NOT call it from inside the transaction —
 * see `prepareEventTaxRate` for the pre-tx / in-tx split the event save uses.
 */
export async function lookupAdmissionTaxRate(
  params: LookupAdmissionTaxRateParams,
): Promise<AdmissionTaxRateResult | null> {
  const outcome = await lookupAdmissionTaxRateOutcome(params);
  return outcome.kind === "rate" ? outcome.result : null;
}

/**
 * {@link lookupAdmissionTaxRate} with the outcome kept: a rate, "no rate for
 * this place", "not looked up", or a FAILED lookup. Never throws for a
 * provider failure — it comes back as `failed` (reported unless
 * `reportFailure: false`).
 */
export async function lookupAdmissionTaxRateOutcome(
  params: LookupAdmissionTaxRateParams,
): Promise<AdmissionTaxRateLookupOutcome> {
  const {
    taxRateLookup,
    postalCode,
    countryCode,
    address,
    clock,
    logger,
    logContext,
    reportError,
    reportFailure = true,
  } = params;

  if (!taxRateLookup || !postalCode || !countryCode) {
    return { kind: "skipped" };
  }

  try {
    const result = await taxRateLookup.lookupByPostalCode({
      postalCode,
      countryCode,
      ...(address?.street
        ? {
            street: address.street,
            city: address.city ?? null,
            region: address.region ?? null,
          }
        : {}),
    });
    if (!result) {
      return { kind: "none" };
    }
    return {
      kind: "rate",
      result: {
        rateBps: result.rateBps,
        source: result.source,
        fetchedAt: clock.now(),
      },
    };
  } catch (err) {
    const failure = toLookupFailure(err);
    if (reportFailure) {
      reportLookupFailure(
        { reportError, logger },
        failure,
        { ...logContext, postalCode },
        "lookupAdmissionTaxRate",
      );
    }
    return { kind: "failed", failure };
  }
}

export function toLookupFailure(err: unknown): TaxRateLookupFailure {
  if (isTaxRateLookupError(err)) {
    return {
      providerCode: err.providerCode,
      httpStatus: err.httpStatus,
      error: err,
    };
  }
  return { providerCode: null, httpStatus: null, error: err };
}

/**
 * Report a failed lookup: `reportError` (guarded, with the provider code in
 * `extra`) plus a log line. The REPORT is what makes it visible in Sentry;
 * the line stays at `warn` (as it always was here) so the pino integration
 * does not file a second copy of every report.
 */
export function reportLookupFailure(
  deps: { reportError?: ReporterPort; logger?: LoggerPort },
  failure: TaxRateLookupFailure,
  extra: Record<string, unknown>,
  useCase: string,
): void {
  try {
    deps.reportError?.(failure.error, {
      tags: { useCase },
      extra: {
        ...extra,
        providerCode: failure.providerCode,
        httpStatus: failure.httpStatus,
      },
    });
  } catch {
    // A throwing reporter must never change the swallow's behaviour.
  }
  deps.logger?.warn("tax_rate_lookup_failed", {
    ...extra,
    providerCode: failure.providerCode,
    httpStatus: failure.httpStatus,
    error: describeError(failure.error),
  });
}
