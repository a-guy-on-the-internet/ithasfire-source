import type {
  CreateSavedLocationInput,
  SavedLocationOwnerType,
  SavedLocationRecord,
} from "@th/types/repos/saved-locations";

export interface SavedLocationsRepo {
  /** Retrieve a saved location by its primary key. */
  getById(id: string): Promise<SavedLocationRecord | null>;
  /**
   * {@link SavedLocationsRepo.getById} for many ids in ONE query: id → record,
   * ids with no row absent.
   */
  getByIds(ids: readonly string[]): Promise<Map<string, SavedLocationRecord>>;
  getAccessibleByOrg(input: {
    id: string;
    orgId: string;
  }): Promise<SavedLocationRecord | null>;
  getAccessibleByHuman(input: {
    id: string;
    humanId: string;
  }): Promise<SavedLocationRecord | null>;
  incrementUsage(id: string): Promise<void>;
  /**
   * Create a new saved location and return the full record.
   */
  create(input: CreateSavedLocationInput): Promise<SavedLocationRecord>;
  /**
   * Find an existing saved location owned by the same entity with the same
   * normalized address (case-insensitive). Used for dedup on auto-create.
   */
  findByOwnerAndAddress(input: {
    ownerType: SavedLocationOwnerType;
    ownerId: string;
    address: string;
  }): Promise<SavedLocationRecord | null>;
  /**
   * Persist a tax rate lookup result on a saved location.
   */
  updateTaxRate(input: {
    id: string;
    admissionTaxRateBps: number;
    taxRateSource: string;
    taxRateFetchedAt: Date;
  }): Promise<void>;
  /**
   * Conditional sibling of {@link updateTaxRate}: writes ONLY when the row
   * still has no cached rate AND still has the postal code / country the
   * lookup was made for. Resolves `true` when it wrote. Same contract and
   * reason as `PlacesRepo.fillTaxRateIfUnset`.
   */
  fillTaxRateIfUnset(input: {
    id: string;
    expectedPostalCode: string | null;
    expectedCountryCode: string | null;
    admissionTaxRateBps: number;
    taxRateSource: string;
    taxRateFetchedAt: Date;
  }): Promise<boolean>;
}

export type {
  SavedLocationOwnerType,
  SavedLocationRecord,
  CreateSavedLocationInput,
} from "@th/types/repos/saved-locations";
