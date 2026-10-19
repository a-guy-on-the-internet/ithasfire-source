export interface PlaceLayoutStatusRepo {
  upsertStatuses(input: { placeId: string; seatIds: string[] }): Promise<void>;
  deleteByPlace(placeId: string): Promise<void>;
}
