import type {
  PlaceWaiverRecord,
  CreatePlaceWaiverInput,
  UpdatePlaceWaiverInput,
  ListPlaceWaiversInput,
} from "@th/types/repos/place-waivers";

export interface PlaceWaiversRepo {
  getById(id: string): Promise<PlaceWaiverRecord | null>;
  create(input: CreatePlaceWaiverInput): Promise<PlaceWaiverRecord>;
  update(input: UpdatePlaceWaiverInput): Promise<PlaceWaiverRecord>;
  delete(id: string): Promise<void>;
  listByPlace(input: ListPlaceWaiversInput): Promise<PlaceWaiverRecord[]>;
  /** Returns the current active waiver for a place (highest version, isActive=true). */
  getActiveForPlace(placeId: string): Promise<PlaceWaiverRecord | null>;
}

export type {
  PlaceWaiverRecord,
  CreatePlaceWaiverInput,
  UpdatePlaceWaiverInput,
  ListPlaceWaiversInput,
} from "@th/types/repos/place-waivers";
