/**
 * Port for reading public music-artist stats from a third-party music-data
 * source. This is provider-agnostic: Spotify is the one concrete adapter today,
 * but the same port is meant to be implemented by aggregators (Soundcharts,
 * Viberate), Bandcamp, or our own source — WITHOUT touching callers/UI. Swap the
 * adapter wired at the composition root and the seam holds.
 *
 * Implementations read PUBLIC catalog data only — there is no per-user OAuth
 * here. When the platform has no credentials configured the port is not wired at
 * all (the dep is `null`), so callers must treat absence as "feature off" and
 * degrade gracefully — mirrors the `TaxRateLookupPort` / Ziptax convention.
 */
export interface MusicStatsPort {
  /**
   * Which provider this adapter is (e.g. `"spotify"`). Lets callers/telemetry
   * know the source of a `MusicArtistStats` without re-deriving it.
   */
  readonly source: MusicStatsSource;

  /**
   * Fetch a public artist by its provider-native artist id (for Spotify, the
   * base-62 id from an `open.spotify.com/artist/{id}` URL). The resolved id is
   * passed as a plain string — resolution of a pasted URL into a provider id is
   * the caller's job. When we add a second provider we'll adjust the resolver
   * then; the port surface stays a single string in.
   *
   * @returns the artist, or `null` when the provider has no such artist (404).
   * @throws on any other non-ok response (auth failure, rate limit, 5xx) so
   *         the failure rides the caller's error handling — the use case
   *         decides whether to swallow-and-report or propagate.
   */
  getArtist(artistId: string): Promise<MusicArtistStats | null>;
}

/**
 * Discriminator for which provider produced a `MusicArtistStats`. Extensible —
 * add a value here (and an adapter) as new providers come online. Only values we
 * plausibly use are listed; `"spotify"` is the one live today.
 */
export type MusicStatsSource =
  | "spotify"
  | "soundcharts"
  | "viberate"
  | "bandcamp";

export interface MusicArtistTopTrack {
  name: string;
  /** 30-second MP3 preview URL, when the provider offers one. */
  previewUrl: string | null;
  /** Public URL to the track on the provider (e.g. `open.spotify.com/track/{id}`). */
  externalUrl: string;
}

export interface MusicArtistStats {
  /** Which provider this record came from — matches the adapter's `source`. */
  source: MusicStatsSource;
  /** The provider-native artist id (e.g. the Spotify base-62 id). */
  providerArtistId: string;
  name: string;
  /** Largest reasonable artist image, or `null` when the artist has none. */
  imageUrl: string | null;
  genres: string[];
  /** Total follower count on the provider, or `null` when unavailable. */
  followers: number | null;
  /**
   * Spotify popularity score 0-100, or `null` when the provider doesn't offer
   * one. Spotify-specific: aggregators generally do NOT provide this.
   */
  popularity: number | null;
  /**
   * Monthly listeners — the headline number aggregators (Soundcharts/Viberate)
   * expose. The Spotify Web API does NOT surface it, so the Spotify adapter
   * always sets this `null`; aggregator adapters would populate it.
   */
  monthlyListeners: number | null;
  /** Public URL to the artist on the provider. */
  externalUrl: string;
  /** Up to ~10 top tracks; omitted when the top-tracks fetch failed. */
  topTracks?: MusicArtistTopTrack[];
}
