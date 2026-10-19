/**
 * Shared CSV-row → place address mapping.
 *
 * Both place CSV importers (the org admin table's `bulkUpsertPlaces` and the
 * platform page's `bulkImportPlaces`) mapped the same columns onto the same
 * address shape, and both papered over a missing street address with a literal
 * `"TBD"` sentinel. That sentinel PERSISTED: it landed in `Place.addrLine1`,
 * fed `Place.address` / `addressHash`, and rendered as the venue's street on
 * public pages — which is why `PlaceMobileCard` still carries a defensive
 * `!== "TBD"` filter.
 *
 * `line1` is optional in `upsertPlace`'s (and now `bulkImportPlaces`') address
 * schema, so an absent street address is a first-class state: the field is
 * simply not sent. `formatted` is NOT optional (`Place.address` is NOT NULL),
 * so when the CSV gives no full-address column the string is REBUILT from the
 * parts the row actually has — the same `", "` join, in the same order, the
 * place editor uses for `rebuiltAddress`, so `addressHash`
 * (`formatted.toLowerCase()` in the Prisma adapter) stays consistent across
 * surfaces.
 */

/** The columns `PLACE_IMPORT_FIELDS` can produce, all optional/raw strings. */
export type PlaceCsvRow = Record<string, string | undefined>;

/** Address payload accepted by both bulk place-import mutations. */
export interface PlaceCsvAddress {
  formatted: string;
  /** `undefined` when the row carries no street address — never a sentinel. */
  line1: string | undefined;
  line2: string | undefined;
  city: string | undefined;
  region: string | undefined;
  postalCode: string | undefined;
  countryCode: string;
}

/** Trim, then treat the empty string as absent. */
function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Build the address payload for one mapped CSV row.
 *
 * Country falls back to `"US"` — pre-existing behaviour of both importers, and
 * the address schema requires a 2-letter code.
 */
export function buildPlaceCsvAddress(row: PlaceCsvRow): PlaceCsvAddress {
  const addressFormatted = value(row.addressFormatted);
  const line1 = value(row.addressLine1);
  const city = value(row.city);
  const region = value(row.region);
  const postalCode = value(row.postalCode);
  const countryCode = value(row.countryCode)?.toUpperCase() ?? "US";

  // Same parts, same order as the place editor's `rebuiltAddress`. The country
  // code always survives the filter, so this is never the empty string — which
  // matters because `formatted` carries a `min(1)` bound on the server.
  const rebuilt = [line1, city, region, postalCode, countryCode]
    .filter(Boolean)
    .join(", ");

  return {
    formatted: addressFormatted ?? line1 ?? rebuilt,
    // The `addressFormatted` fallback is kept deliberately: a "Full Address"
    // column is very often just the street ("713 Congress Ave" is exactly that
    // in this repo's own seed data), so it is real user data for this field —
    // unlike `"TBD"`, which was a forged constant. With neither column filled,
    // the place simply has no street address.
    line1: line1 ?? addressFormatted,
    line2: value(row.addressLine2),
    city,
    region,
    postalCode,
    countryCode,
  };
}
