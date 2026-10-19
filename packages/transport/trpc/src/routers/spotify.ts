import {
  getSpotifyArtist,
  getSpotifyArtistInputSchema,
  getSpotifyArtistOutputSchema,
} from "@th/core/use-cases/spotify";

import { authedProcedure } from "../init";

// The `spotify` router name is a provider label — Spotify is the one wired
// music-stats source today. The procedure output is the provider-agnostic
// `MusicArtistStats`, so the seam can generalize to another provider without
// renaming this path.
export const spotifyRouter = {
  /**
   * Fetch public artist stats (Spotify today) for a pasted artist URL or id.
   *
   * `authedProcedure` (not public) to keep our shared app-token quota from
   * being abused by anonymous callers. Returns `{ configured: false }` when
   * the provider's credentials are not wired. Follow-up: a per-actor rate limit
   * on this procedure if lookup volume grows.
   */
  getArtist: authedProcedure
    .input(getSpotifyArtistInputSchema)
    .output(getSpotifyArtistOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        musicStats: ctx.musicStats ?? undefined,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getSpotifyArtist>[0];

      return getSpotifyArtist(deps, input);
    }),
};
