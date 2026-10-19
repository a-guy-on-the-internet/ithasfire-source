export interface PlaceLayoutStreamingPort {
  publishPlaceLayoutReplaced(input: {
    placeId: string;
    checksum: string | null;
  }): Promise<void>;
}
