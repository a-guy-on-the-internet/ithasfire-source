/**
 * Static Canadian GST/HST admission-tax rates, in basis points, keyed by the
 * two-letter province/territory code (the value we already store in the
 * `region` column on Event / Place / SavedLocation).
 *
 * Canada needs no rate *API*: the whole country is ~a dozen province-level
 * rates. This is a parallel branch to the US ZipTax path — see
 * `docs/specs/2026-07-01/completed/tax-collection-and-compliance-readiness.md` §5.1.
 *
 * SCOPE (deliberate):
 *  - GST-only provinces/territories are fully supported at their flat 5% GST.
 *  - HST provinces are listed but commented out until we operate there — the
 *    combined HST rate collects correctly the day we uncomment them.
 *  - PST/QST provinces (BC, SK, MB, QC) require GST + a SEPARATE provincial
 *    sales tax we do NOT compute here. They are intentionally OMITTED from the
 *    map so an event there resolves to "no rate" + a loud warning rather than
 *    silently UNDER-collecting the missing PST/QST. (Charging just the 5% GST
 *    would be worse than surfacing the gap.) Add them only when the PST/QST
 *    calc is built.
 *
 * Our only live Canadian jurisdiction today is Alberta (Edmonton): flat 5%
 * GST, no PST, no local variation — the simplest possible case.
 */
export const CANADA_GST_HST_BPS: Record<string, number> = {
  // ── GST-only (flat 5%, no provincial sales tax) ──────────────────────────
  AB: 500, // Alberta
  NT: 500, // Northwest Territories
  NU: 500, // Nunavut
  YT: 500, // Yukon

  // ── HST provinces (GST + provincial portion, single combined rate) ───────
  // Uncomment when we operate there; the combined rate is correct as-is.
  // ON: 1300, // Ontario
  // NB: 1500, // New Brunswick
  // NL: 1500, // Newfoundland and Labrador
  // NS: 1400, // Nova Scotia (dropped to 14% on 2025-04-01)
  // PE: 1500, // Prince Edward Island

  // ── PST/QST provinces — INTENTIONALLY UNSUPPORTED (see file docstring) ───
  // BC, SK, MB, QC: GST (5%) + a separate PST/QST calc that is out of scope.
};

/** Audit / `taxRateSource` label for a rate resolved from the Canada map. */
export const CANADA_TAX_RATE_SOURCE = "ca_gst_hst";

/**
 * First-letter → province/territory code map for Canadian postal codes.
 * The first character of a Canadian postal code deterministically identifies
 * the province/territory (Canada Post FSA scheme). Used as a fallback when the
 * stored `region` code is missing, so Canadian events still resolve a province.
 *
 * Ambiguous letters:
 *  - X spans NT and NU — we map it to NT (both are flat 5% GST, so the RATE is
 *    identical; only the situs label differs, and NT is the conventional pick).
 */
const CANADIAN_POSTAL_FIRST_LETTER_TO_PROVINCE: Record<string, string> = {
  A: "NL", // Newfoundland and Labrador
  B: "NS", // Nova Scotia
  C: "PE", // Prince Edward Island
  E: "NB", // New Brunswick
  G: "QC", // Quebec (east)
  H: "QC", // Quebec (Montreal)
  J: "QC", // Quebec (west)
  K: "ON", // Ontario (east)
  L: "ON", // Ontario (central)
  M: "ON", // Ontario (Toronto)
  N: "ON", // Ontario (southwest)
  P: "ON", // Ontario (north)
  R: "MB", // Manitoba
  S: "SK", // Saskatchewan
  T: "AB", // Alberta
  V: "BC", // British Columbia
  X: "NT", // Northwest Territories / Nunavut (rate-identical; NT chosen)
  Y: "YT", // Yukon
};

/**
 * Best-effort resolution of the two-letter Canadian province/territory code
 * from a postal code's first letter. Returns `null` when the postal code is
 * missing or its first letter is not a recognized Canadian FSA prefix.
 */
export function provinceFromCanadianPostalCode(
  postalCode: string | null | undefined,
): string | null {
  if (!postalCode) return null;
  const firstLetter = postalCode.trim().charAt(0).toUpperCase();
  return CANADIAN_POSTAL_FIRST_LETTER_TO_PROVINCE[firstLetter] ?? null;
}

/**
 * Resolve the Canadian GST/HST rate (bps) for a venue from its stored province
 * `region` code, falling back to the postal-code first-letter when the region
 * is missing. Returns the resolved province and rate so callers can both stamp
 * the tax and snapshot the situs.
 *
 * When the province cannot be determined, or it is an unsupported PST/QST
 * province, `rateBps` is `null` — the caller MUST log, report and collect no tax
 * rather than silently under-collect.
 */
export function resolveCanadaGstHst(params: {
  region: string | null | undefined;
  postalCode: string | null | undefined;
}): { province: string | null; rateBps: number | null } {
  const region = params.region?.trim().toUpperCase() || null;
  const province =
    region ?? provinceFromCanadianPostalCode(params.postalCode);

  if (!province) {
    return { province: null, rateBps: null };
  }

  const rateBps = CANADA_GST_HST_BPS[province];
  return {
    province,
    rateBps: rateBps ?? null,
  };
}
