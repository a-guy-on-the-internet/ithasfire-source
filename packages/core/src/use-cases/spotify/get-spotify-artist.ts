import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { MusicArtistStats, MusicStatsPort } from "@th/ports/music-stats";

import { parseInput } from "../../lib/io";
import { parseEmbedUrl } from "../../lib/embeds/parse-embed-url";

/** Spotify ids are 22-char base-62 strings. */
const RAW_SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

export const getSpotifyArtistInputSchema = z
  .object({
    /** A pasted `open.spotify.com/artist/{id}` URL or a bare artist id. */
    urlOrId: z.string().trim().min(1).max(512),
  })
  .strict();

export type GetSpotifyArtistInput = z.infer<typeof getSpotifyArtistInputSchema>;

const musicArtistTopTrackSchema = z
  .object({
    name: z.string(),
    previewUrl: z.string().nullable(),
    externalUrl: z.string(),
  })
  .strict();

export const musicArtistStatsSchema = z
  .object({
    source: z.enum(["spotify", "soundcharts", "viberate", "bandcamp"]),
    providerArtistId: z.string(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    genres: z.array(z.string()),
    followers: z.number().nullable(),
    popularity: z.number().nullable(),
    monthlyListeners: z.number().nullable(),
    externalUrl: z.string(),
    topTracks: z.array(musicArtistTopTrackSchema).optional(),
  })
  .strict();

export const getSpotifyArtistOutputSchema = z
  .object({
    /**
     * `false` when the music-stats provider (Spotify today) has no credentials
     * configured (feature off).
     */
    configured: z.boolean(),
    artist: musicArtistStatsSchema.nullable(),
  })
  .strict();

export type GetSpotifyArtistOutput = z.infer<
  typeof getSpotifyArtistOutputSchema
>;

export type GetSpotifyArtistDeps = {
  /**
   * Provider-agnostic music-stats read port (Spotify is the one wired today).
   * `null`/absent when the platform has no provider credentials configured —
   * the use case then returns `configured: false`.
   */
  musicStats?: MusicStatsPort | null;
  logger?: LoggerPort;
  /**
   * Best-effort error reporter, fired when a live Spotify lookup fails and we
   * swallow it (returning `artist: null` instead of throwing). Without this the
   * external-API failure would be invisible in Sentry. Never affects behaviour.
   */
  reportError?: ReporterPort;
};

/**
 * Resolve a pasted Spotify artist URL or bare id to a validated artist id.
 * Only ever accepts Spotify **artist** URLs/ids — non-Spotify hosts, non-artist
 * kinds (track/album/…), and malformed ids all return `null`.
 */
export function resolveSpotifyArtistId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  if (RAW_SPOTIFY_ID_RE.test(trimmed)) return trimmed;

  const parsed = parseEmbedUrl(trimmed);
  if (!parsed || parsed.provider !== "spotify" || parsed.kind !== "artist") {
    return null;
  }
  return parsed.externalId;
}

/**
 * Fetch public Spotify artist data (name, image, genres, followers,
 * popularity, top tracks) for a pasted artist URL or id.
 *
 * Degrades gracefully:
 * - Unconfigured (no `deps.spotify`) → `{ configured: false, artist: null }`.
 * - Live Spotify failure → swallow, report to Sentry, return
 *   `{ configured: true, artist: null }` (best-effort enrichment must never
 *   break the caller flow).
 * - Unknown artist (404) → `{ configured: true, artist: null }`.
 *
 * Invalid input (non-Spotify / non-artist URL) throws `invalid_input`
 * (BAD_REQUEST) with `message: "invalid_spotify_artist"`.
 */
export async function getSpotifyArtist(
  deps: GetSpotifyArtistDeps,
  rawInput: unknown,
): Promise<GetSpotifyArtistOutput> {
  const input = parseInput(getSpotifyArtistInputSchema, rawInput);

  const artistId = resolveSpotifyArtistId(input.urlOrId);
  if (!artistId) {
    // `invalid_input` maps to BAD_REQUEST in the tRPC error map; the domain
    // reason rides in `message` (matches record-cash-sale et al.). Using an
    // unmapped code here would fall through to 500 + a Sentry event for plain
    // bad user input.
    throw {
      code: "invalid_input",
      message: "invalid_spotify_artist",
    } as const;
  }

  if (!deps.musicStats) {
    return { configured: false, artist: null };
  }

  try {
    const artist: MusicArtistStats | null =
      await deps.musicStats.getArtist(artistId);
    return { configured: true, artist };
  } catch (error) {
    deps.logger?.warn?.("spotify.get_artist_failed", {
      artistId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "getSpotifyArtist" },
        extra: { artistId },
      });
    } catch {
      // Reporting is best-effort — a throwing reporter must never turn the
      // graceful null fallback into a thrown error.
    }
    return { configured: true, artist: null };
  }
}
