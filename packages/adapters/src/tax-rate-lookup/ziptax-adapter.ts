import type { ReporterPort } from "@th/ports/reporter";
import {
  TaxRateLookupError,
  type TaxRateLookupInput,
  type TaxRateLookupPort,
  type TaxRateLookupResult,
} from "@th/ports/tax-rate-lookup";

const ZIPTAX_V50_URL = "https://api.zip-tax.com/request/v50";
const ZIPTAX_V60_URL = "https://api.zip-tax.com/request/v60";
const ZIPTAX_TIMEOUT_MS = 5_000;

/** ZipTax `RESPONSE_CODE_SUCCESS`. */
const RCODE_SUCCESS = 100;

/**
 * ZipTax codes that mean "the provider answered: it cannot place this
 * location" — a fact about the input, not a failure. Retrying the same input
 * gives the same answer, so they resolve `null` (no rate for this place)
 * rather than an error:
 *   102 invalid state · 103 invalid city · 104 invalid postal code ·
 *   109 address incomplete / not a real address · 110 no result.
 *
 * EVERY other non-100 code is a FAILURE and throws — notably 108 (rate
 * limit), 101 (invalid key), 106 (ZipTax's own error), 107/112/113 (plan
 * entitlements) and 105 (malformed query, which is our bug). See
 * https://docs.zip.tax/guides/reference/response-codes.md.
 */
const NOT_FOUND_CODES: ReadonlySet<number> = new Set([102, 103, 104, 109, 110]);

/**
 * Ziptax adapter — resolves the combined sales tax rate for a US location.
 *
 * Pricing: $29/mo Growth plan (unlimited lookups).
 * Docs:    https://docs.zip.tax
 *
 * TWO ENDPOINTS:
 *  - With a street address: v6.0 `address=` — a rooftop-level rate that
 *    honours city limits and special districts. The rate is the
 *    `taxSummaries` entry with `taxType: "SALES_TAX"`. Verified 2026-10-05
 *    with the dev key (Target Center, 600 N 1st Ave 55403 → 0.09025).
 *  - Otherwise, or when the address lookup did not produce a rate: v5.0
 *    `postalcode=` — the first result's `taxSales`.
 *
 * OUTCOMES (the port's contract): a rate (0 included, when ZipTax says 0), or
 * `null` when ZipTax cannot place the location, or a THROWN
 * {@link TaxRateLookupError} carrying the ZipTax code / HTTP status when the
 * lookup failed. This adapter used to map every non-100 code to `null`, so a
 * rate-limited lookup (108) read as "no tax here" and checkout charged 0%.
 *
 * Both versions return the code in the BODY (v6.0 at `metadata.response.code`,
 * v5.0 and older at top-level `rCode`), and v6.0 also sets a matching non-2xx
 * HTTP status (108 → 429), so the body is read before the status is judged.
 */
export function createZiptaxAdapter(
  apiKey: string,
  options: {
    /** Test seam; production uses the global `fetch`. */
    fetchImpl?: typeof fetch;
    /**
     * Reports an address lookup that FAILED while the postal-code fallback
     * still produced a rate. The caller gets a rate, so nothing else would
     * ever show it — and a broken v60 path (bad plan entitlement, 108 spell)
     * silently degrades every venue to postal precision. Guarded: a throwing
     * reporter never changes the result.
     */
    reportError?: ReporterPort;
  } = {},
): TaxRateLookupPort {
  const fetchImpl = options.fetchImpl ?? fetch;

  function reportAddressFallback(failure: TaxRateLookupError): void {
    try {
      // The error message and these fields carry no key and no URL.
      options.reportError?.(failure, {
        tags: { area: "tax", op: "ziptax_address_lookup_fallback" },
        extra: {
          providerCode: failure.providerCode,
          httpStatus: failure.httpStatus,
        },
      });
    } catch {
      // A reporter failure must never change the lookup's result.
    }
  }

  async function call(url: URL): Promise<ZiptaxCall> {
    url.searchParams.set("key", apiKey);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(ZIPTAX_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout (AbortSignal) or network failure: nothing came back.
      throw new TaxRateLookupError(
        `Ziptax request failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const code = responseCode(body);
    if (code === null) {
      // No ZipTax code to branch on: an HTTP error page, an empty or
      // unparseable body. Unknown, never "no rate".
      throw new TaxRateLookupError(
        `Ziptax HTTP ${res.status}: ${text.slice(0, 200)}`,
        { httpStatus: res.status },
      );
    }
    return { code, body, httpStatus: res.status };
  }

  /** v6.0 street-address lookup. `null` = ZipTax cannot place the address. */
  async function byAddress(address: string): Promise<number | null> {
    const url = new URL(ZIPTAX_V60_URL);
    url.searchParams.set("address", address);
    const { code, body, httpStatus } = await call(url);
    if (code === RCODE_SUCCESS) {
      const rate = v60SalesRate(body);
      if (rate === null) {
        throw new TaxRateLookupError(
          "Ziptax v60 success without a SALES_TAX summary",
          { providerCode: code, httpStatus },
        );
      }
      return rate;
    }
    if (NOT_FOUND_CODES.has(code)) return null;
    throw ziptaxCodeError(code, body, httpStatus);
  }

  /** v5.0 postal-code lookup. `null` = ZipTax has no rate for the code. */
  async function byPostalCode(zip5: string): Promise<number | null> {
    const url = new URL(ZIPTAX_V50_URL);
    url.searchParams.set("postalcode", zip5);
    const { code, body, httpStatus } = await call(url);
    if (code === RCODE_SUCCESS) {
      const results = (body as ZiptaxV50Response).results;
      if (!results?.length) return null;
      // First result = the primary jurisdiction for the zip code.
      const rate = results[0]!.taxSales;
      if (typeof rate !== "number" || !Number.isFinite(rate)) {
        throw new TaxRateLookupError(
          "Ziptax v50 success without a numeric taxSales",
          { providerCode: code, httpStatus },
        );
      }
      return rate;
    }
    if (NOT_FOUND_CODES.has(code)) return null;
    throw ziptaxCodeError(code, body, httpStatus);
  }

  return {
    async lookupByPostalCode(
      input: TaxRateLookupInput,
    ): Promise<TaxRateLookupResult | null> {
      // Ziptax only covers the US here (Canada comes from the static table).
      if (input.countryCode.toUpperCase() !== "US") {
        return null;
      }

      // Strip the +4 suffix if present (e.g. "78701-1234" → "78701").
      const zip5 = input.postalCode.replace(/-.*$/, "").trim();
      const zipValid = /^\d{5}$/.test(zip5);
      const address = formatAddress(input, zipValid ? zip5 : null);

      // Address first when we have a street: the more precise answer. A
      // FAILED address lookup is not the last word either — the postal-code
      // lookup may still answer — but if that cannot produce a rate the
      // address failure is what we report.
      let addressFailure: TaxRateLookupError | null = null;
      if (address) {
        try {
          const rate = await byAddress(address);
          if (rate !== null) return toResult(rate);
        } catch (err) {
          addressFailure = asLookupError(err);
        }
      }

      if (!zipValid) {
        if (addressFailure) throw addressFailure;
        return null;
      }

      const rate = await byPostalCode(zip5).catch((err: unknown) => {
        // Both failed: surface the address failure when there was one (the
        // primary lookup), the postal one otherwise.
        throw addressFailure ?? asLookupError(err);
      });
      if (rate !== null) {
        // The postal code answered, but the address lookup had FAILED: the
        // caller is fine, the precision is not. Make that visible.
        if (addressFailure) reportAddressFallback(addressFailure);
        return toResult(rate);
      }
      if (addressFailure) throw addressFailure;
      return null;
    },
  };
}

function toResult(decimalRate: number): TaxRateLookupResult {
  // Decimal rate (e.g. 0.0825) → basis points (825).
  return { rateBps: Math.round(decimalRate * 10_000), source: "ziptax" };
}

function asLookupError(err: unknown): TaxRateLookupError {
  return err instanceof TaxRateLookupError
    ? err
    : new TaxRateLookupError(
        `Ziptax lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
}

function ziptaxCodeError(
  code: number,
  body: unknown,
  httpStatus: number,
): TaxRateLookupError {
  const name = responseName(body);
  return new TaxRateLookupError(
    `Ziptax rCode ${code}${name ? ` (${name})` : ""}`,
    { providerCode: code, httpStatus },
  );
}

/**
 * "600 N 1st Ave, Minneapolis, MN 55403". Null without a street. A saved
 * location's free-text address may already carry the city and zip; then it is
 * sent as typed (ZipTax normalizes it) rather than doubled up.
 */
function formatAddress(
  input: TaxRateLookupInput,
  zip5: string | null,
): string | null {
  const street = input.street?.trim();
  if (!street) return null;
  if (zip5 && street.includes(zip5)) return street;
  const stateZip = [input.region?.trim(), zip5].filter(Boolean).join(" ");
  return [street, input.city?.trim(), stateZip].filter(Boolean).join(", ");
}

/** v6.0 puts the code at `metadata.response.code`, v5.0 at `rCode`. */
function responseCode(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const v60 = (body as ZiptaxV60Response).metadata?.response?.code;
  if (typeof v60 === "number") return v60;
  const v50 = (body as ZiptaxV50Response).rCode;
  if (typeof v50 === "number") return v50;
  return null;
}

function responseName(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const name =
    (body as ZiptaxV60Response).metadata?.response?.name ??
    (body as ZiptaxV50Response).rName;
  return typeof name === "string" ? name : null;
}

function v60SalesRate(body: unknown): number | null {
  const summaries = (body as ZiptaxV60Response).taxSummaries;
  const sales = summaries?.find((s) => s.taxType === "SALES_TAX");
  const rate = sales?.rate;
  return typeof rate === "number" && Number.isFinite(rate) ? rate : null;
}

// ── Ziptax response types ────────────────────────────────────────────────────

type ZiptaxCall = { code: number; body: unknown; httpStatus: number };

interface ZiptaxV60Response {
  metadata?: {
    version?: string;
    response?: { code?: number; name?: string; message?: string };
  };
  taxSummaries?: Array<{ rate?: number; taxType?: string }>;
  addressDetail?: { normalizedAddress?: string; incorporated?: string };
}

interface ZiptaxV50Response {
  version?: string;
  rCode?: number;
  rName?: string;
  results?: ZiptaxV50Result[] | null;
}

interface ZiptaxV50Result {
  geoPostalCode: string;
  geoCity: string;
  geoCounty: string;
  geoState: string;
  taxSales: number;
  taxUse: number;
}
