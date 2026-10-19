import type { ClockPort } from "@th/ports/clock";
import type {
  MusicArtistStats,
  MusicArtistTopTrack,
  MusicStatsPort,
} from "@th/ports/music-stats";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const REQUEST_TIMEOUT_MS = 5_000;
/**
 * Refresh the app token this many ms BEFORE its stated expiry, so an in-flight
 * request never races the boundary. Spotify tokens live ~1h, so 30s is ample.
 */
const TOKEN_EXPIRY_SKEW_MS = 30_000;
/** Only ever accept a base-62 Spotify id — defense against SSRF path injection. */
const SPOTIFY_ID_RE = /^[A-Za-z0-9]+$/;

export interface SpotifyAdapterOptions {
  clientId: string;
  clientSecret: string;
  /** Injectable clock for token-expiry math; defaults to `Date.now`. */
  clock?: ClockPort;
}

/**
 * Spotify Web API adapter — reads public artist data using the Client
 * Credentials flow. A single app-level token is fetched, cached per-process
 * in memory, and refreshed shortly before it expires. There is NO per-user
 * OAuth: this only reads public catalog data.
 *
 * The cache is intentionally per-process (a fresh token fetch on cold start is
 * cheap and the token is never persisted). If this ever fans out to many
 * instances with tight Spotify rate limits, a shared Redis-backed token cache
 * would be the next step — not needed today.
 *
 * NOTE: "monthly listeners" is NOT available via the Web API — only
 * `followers` and `popularity`.
 */
export function createSpotifyAdapter(
  options: SpotifyAdapterOptions,
): MusicStatsPort {
  const { clientId, clientSecret } = options;
  const now = (): number =>
    options.clock ? options.clock.now().getTime() : Date.now();

  // Basic auth header for the token endpoint. Never logged.
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  let cachedToken: string | null = null;
  let expiresAt = 0;

  const fetchToken = async (): Promise<string> => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Do NOT include the response body — it can echo back credentials.
      throw new Error(`Spotify token request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as SpotifyTokenResponse;
    if (!body.access_token || typeof body.expires_in !== "number") {
      throw new Error("Spotify token response missing access_token/expires_in");
    }

    cachedToken = body.access_token;
    expiresAt = now() + body.expires_in * 1_000 - TOKEN_EXPIRY_SKEW_MS;
    return cachedToken;
  };

  const getToken = async (forceRefresh = false): Promise<string> => {
    if (!forceRefresh && cachedToken && now() < expiresAt) {
      return cachedToken;
    }
    return fetchToken();
  };

  /**
   * Perform an authenticated GET against the Spotify API. On a 401 (token
   * expired or revoked mid-flight) refresh the token ONCE and retry.
   */
  const apiGet = async (path: string): Promise<Response> => {
    let token = await getToken();
    let res = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status === 401) {
      token = await getToken(true);
      res = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }

    return res;
  };

  const fetchTopTracks = async (
    artistId: string,
  ): Promise<MusicArtistTopTrack[] | undefined> => {
    // Best-effort enrichment: a top-tracks failure must NOT sink the whole
    // artist lookup, so we swallow here and let the caller return the artist
    // without tracks.
    try {
      const res = await apiGet(
        `/artists/${artistId}/top-tracks?market=US`,
      );
      if (!res.ok) return undefined;
      const body = (await res.json()) as SpotifyTopTracksResponse;
      return (body.tracks ?? []).map((t) => ({
        name: t.name,
        previewUrl: t.preview_url ?? null,
        externalUrl:
          t.external_urls?.spotify ??
          `https://open.spotify.com/track/${t.id}`,
      }));
    } catch {
      return undefined;
    }
  };

  return {
    source: "spotify",

    async getArtist(artistId: string): Promise<MusicArtistStats | null> {
      // SSRF guard: only ever interpolate a validated base-62 id into the path.
      if (!SPOTIFY_ID_RE.test(artistId)) {
        return null;
      }

      const res = await apiGet(`/artists/${artistId}`);

      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Spotify artist request failed: HTTP ${res.status}`);
      }

      const artist = (await res.json()) as SpotifyArtistResponse;
      const topTracks = await fetchTopTracks(artistId);

      return {
        source: "spotify",
        providerArtistId: artist.id,
        name: artist.name,
        imageUrl: pickLargestImage(artist.images),
        genres: artist.genres ?? [],
        followers:
          typeof artist.followers?.total === "number"
            ? artist.followers.total
            : null,
        popularity:
          typeof artist.popularity === "number" ? artist.popularity : null,
        // The Spotify Web API does not expose monthly listeners — only
        // followers/popularity — so this is always null for the Spotify source.
        monthlyListeners: null,
        externalUrl:
          artist.external_urls?.spotify ??
          `https://open.spotify.com/artist/${artist.id}`,
        ...(topTracks ? { topTracks } : {}),
      };
    },
  };
}

/**
 * Spotify returns `images` ordered largest-first, but we don't rely on order:
 * pick the entry with the greatest `width * height`, falling back to the first
 * with a URL. Returns `null` when there are no images.
 */
function pickLargestImage(images: SpotifyImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  let best: SpotifyImage | null = null;
  let bestArea = -1;
  for (const img of images) {
    if (!img.url) continue;
    const area = (img.width ?? 0) * (img.height ?? 0);
    if (area > bestArea) {
      bestArea = area;
      best = img;
    }
  }
  return best?.url ?? images[0]?.url ?? null;
}

// ── Spotify API response types (subset we consume) ───────────────────────────

interface SpotifyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyImage {
  url: string;
  width: number | null;
  height: number | null;
}

interface SpotifyArtistResponse {
  id: string;
  name: string;
  images?: SpotifyImage[];
  genres?: string[];
  followers?: { total: number | null } | null;
  popularity?: number;
  external_urls?: { spotify?: string };
}

interface SpotifyTrack {
  id: string;
  name: string;
  preview_url: string | null;
  external_urls?: { spotify?: string };
}

interface SpotifyTopTracksResponse {
  tracks: SpotifyTrack[] | null;
}
