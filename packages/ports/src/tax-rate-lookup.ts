/**
 * Port for looking up the combined sales/admission tax rate for a place.
 *
 * Implementations may call external APIs (e.g. Ziptax) or return
 * a hardcoded rate for testing.
 *
 * THREE OUTCOMES, never two. A caller must be able to tell "this place has no
 * rate" from "we could not find out":
 *
 *  - a {@link TaxRateLookupResult} — the provider answered with a rate. A
 *    `rateBps` of 0 is a REAL zero (the provider said so) and may be charged.
 *  - `null` — the provider answered, and it has no rate for this place: an
 *    unsupported country, a postal code / address it cannot resolve. Nothing
 *    went wrong; retrying will not change the answer.
 *  - a REJECTION with a {@link TaxRateLookupError} — the lookup FAILED: the
 *    provider returned an error code (rate limited, bad key, its own outage),
 *    an HTTP error, a timeout or a body we could not read. The rate is
 *    UNKNOWN, and a caller must never read it as 0. (Before 2026-10-06 the
 *    ZipTax adapter mapped a rate-limit answer to `null`, and checkout
 *    charged 0% on it.)
 */
export interface TaxRateLookupPort {
  /**
   * Look up the combined sales tax rate for a location.
   *
   * The name is historical: the postal code is the one required field, but
   * when `street` is given the implementation should prefer a street-ADDRESS
   * lookup (a rooftop-level rate that honours city limits and special
   * districts) and fall back to the postal code when the address cannot be
   * resolved.
   *
   * @returns The combined rate in basis points (e.g. 975 = 9.75%) and a
   *          source label for audit ("ziptax", "manual", etc.), or `null`
   *          when the provider has no rate for this place.
   * @throws  {@link TaxRateLookupError} when the lookup failed.
   */
  lookupByPostalCode(
    input: TaxRateLookupInput,
  ): Promise<TaxRateLookupResult | null>;
}

export interface TaxRateLookupInput {
  postalCode: string;
  /** Two-letter country code. Only "US" is currently supported. */
  countryCode: string;
  /** Street line ("600 N 1st Ave"). Present = an address lookup is preferred. */
  street?: string | null;
  /** City / locality, used with `street`. */
  city?: string | null;
  /** Two-letter state / province code, used with `street`. */
  region?: string | null;
}

export interface TaxRateLookupResult {
  /** Combined sales tax rate in basis points (e.g. 975 = 9.75%). */
  rateBps: number;
  /** Human-readable source for audit trail. */
  source: string;
}

/**
 * A FAILED lookup: the rate is unknown. See {@link TaxRateLookupPort}.
 *
 * `providerCode` is the provider's own response code when it sent one (ZipTax:
 * 108 = rate limit exceeded, 101 = invalid key, 106 = its own API error);
 * `httpStatus` is set for an HTTP-level failure. Both null for a timeout or a
 * network error.
 */
export class TaxRateLookupError extends Error {
  readonly code = "tax_rate_lookup_failed" as const;
  readonly providerCode: number | null;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    details: {
      providerCode?: number | null;
      httpStatus?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : {});
    this.name = "TaxRateLookupError";
    this.providerCode = details.providerCode ?? null;
    this.httpStatus = details.httpStatus ?? null;
  }
}

/**
 * Structural on purpose (same reason as `isScheduleNotSentError`): core and an
 * adapter can hold two copies of this module, and `instanceof` would say no.
 */
export function isTaxRateLookupError(
  error: unknown,
): error is TaxRateLookupError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "tax_rate_lookup_failed"
  );
}
