import type { SeatGlyph } from "./types";

export interface PlaceLayoutBlobRepo {
  putForPlace(input: {
    placeId: string;
    glyphs: SeatGlyph[];
    checksumHint?: string | null;
  }): Promise<{ checksum: string }>;

  /**
   * Returns a fetchable (possibly signed) URL for the glyph snapshot blob
   * associated with this place and checksum.
   *
   * Returns `null` when no snapshot exists for the given place/checksum pair.
   */
  getGlyphUrl(input: {
    placeId: string;
    checksum: string;
  }): Promise<{ url: string } | null>;

  deleteForPlace(placeId: string): Promise<void>;
}
