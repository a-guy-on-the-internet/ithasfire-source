export type SavedLocationOwnerType = "HUMAN" | "ORGANIZATION";

export interface SavedLocationRecord {
  id: string;
  name: string;
  address: string | null;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * IANA timezone derived from `lat`/`lng` when the address was first
   * normalized into this row (venue-hierarchy FR-004) — the freeform mirror of
   * `PlaceRecord.timezone`. Null = no derived answer (no coordinates, the
   * lookup failed, or the row predates the column); callers fall through to
   * their own default rather than guessing.
   */
  timezone: string | null;
  ownerType: SavedLocationOwnerType;
  ownerId: string;
  usageCount: number;
  /** Admission tax rate in basis points (e.g. 975 = 9.75%). Null = not yet looked up. */
  admissionTaxRateBps: number | null;
  /** When the tax rate was last fetched from the external provider. */
  taxRateFetchedAt: Date | null;
  /** Source of the cached rate: "ziptax", "manual", etc. */
  taxRateSource: string | null;
}

export interface CreateSavedLocationInput {
  name: string;
  address: string | null;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  /**
   * Address-derived IANA timezone. Optional: an omitted/null value stores null,
   * which the readers treat as "no derived answer".
   */
  timezone?: string | null;
  ownerType: SavedLocationOwnerType;
  ownerId: string;
}
