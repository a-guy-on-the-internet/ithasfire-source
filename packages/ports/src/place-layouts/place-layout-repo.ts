import type {
  PlaceLayoutSnapshot,
  SeatIndexBounds,
  SeatSection,
  StageLayout,
} from "./types";

export type PlaceLayoutRecord = PlaceLayoutSnapshot & {
  seatIds: string[];
  /** Null when the creating account has been deleted (creator detached). */
  createdByHumanId: string | null;
};

export type ReplacePlaceLayoutInput = {
  placeId: string;
  checksum: string;
  createdByHumanId: string;
  sections: SeatSection[];
  seatIds: string[];
  seatIndexBounds: SeatIndexBounds;
  stage?: StageLayout | null;
};

export interface PlaceLayoutRepo {
  getById(id: string): Promise<PlaceLayoutRecord | null>;
  getByPlace(placeId: string): Promise<PlaceLayoutRecord | null>;
  listByPlace(placeId: string): Promise<PlaceLayoutRecord[]>;
  replaceWithSnapshot(
    input: ReplacePlaceLayoutInput,
  ): Promise<PlaceLayoutRecord>;
  deleteForPlace(
    placeId: string,
  ): Promise<{ deleted: boolean; checksum?: string | null }>;
}
