import { describe, expect, it, vi } from "vitest";

import type { MusicArtistStats, MusicStatsPort } from "@th/ports/music-stats";

import {
  getSpotifyArtist,
  resolveSpotifyArtistId,
} from "../get-spotify-artist";

const ARTIST_ID = "0TnOYISbd1XYRBk9myaseg";
const ARTIST_URL = `https://open.spotify.com/artist/${ARTIST_ID}`;

const artist: MusicArtistStats = {
  source: "spotify",
  providerArtistId: ARTIST_ID,
  name: "Test Artist",
  imageUrl: "https://i.scdn.co/large.jpg",
  genres: ["indie"],
  followers: 100,
  popularity: 42,
  monthlyListeners: null,
  externalUrl: ARTIST_URL,
  topTracks: [{ name: "S1", previewUrl: null, externalUrl: "u" }],
};

function makeSpotify(
  impl: (id: string) => Promise<MusicArtistStats | null>,
): MusicStatsPort {
  return { source: "spotify", getArtist: vi.fn(impl) };
}

describe("resolveSpotifyArtistId", () => {
  it("accepts a bare 22-char base-62 id", () => {
    expect(resolveSpotifyArtistId(ARTIST_ID)).toBe(ARTIST_ID);
  });

  it("extracts the id from an artist URL", () => {
    expect(resolveSpotifyArtistId(ARTIST_URL)).toBe(ARTIST_ID);
  });

  it("extracts the id from an /embed/artist URL", () => {
    expect(
      resolveSpotifyArtistId(
        `https://open.spotify.com/embed/artist/${ARTIST_ID}`,
      ),
    ).toBe(ARTIST_ID);
  });

  it("rejects a non-artist Spotify URL (track)", () => {
    expect(
      resolveSpotifyArtistId(`https://open.spotify.com/track/${ARTIST_ID}`),
    ).toBeNull();
  });

  it("rejects a non-Spotify host", () => {
    expect(
      resolveSpotifyArtistId(`https://example.com/artist/${ARTIST_ID}`),
    ).toBeNull();
  });

  it("rejects garbage", () => {
    expect(resolveSpotifyArtistId("not a url")).toBeNull();
  });
});

describe("getSpotifyArtist", () => {
  it("degrades to configured:false when the port is not wired", async () => {
    const reportError = vi.fn();
    const result = await getSpotifyArtist(
      { musicStats: null, reportError },
      { urlOrId: ARTIST_URL },
    );

    expect(result).toEqual({ configured: false, artist: null });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fetches the artist for a valid URL", async () => {
    const spotify = makeSpotify(async () => artist);
    const result = await getSpotifyArtist({ musicStats: spotify }, { urlOrId: ARTIST_URL });

    expect(result).toEqual({ configured: true, artist });
    expect(spotify.getArtist).toHaveBeenCalledWith(ARTIST_ID);
  });

  it("fetches the artist for a bare id", async () => {
    const spotify = makeSpotify(async () => artist);
    const result = await getSpotifyArtist({ musicStats: spotify }, { urlOrId: ARTIST_ID });

    expect(result.configured).toBe(true);
    expect(spotify.getArtist).toHaveBeenCalledWith(ARTIST_ID);
  });

  it("returns configured:true, artist:null for an unknown artist (404)", async () => {
    const reportError = vi.fn();
    const spotify = makeSpotify(async () => null);
    const result = await getSpotifyArtist(
      { musicStats: spotify, reportError },
      { urlOrId: ARTIST_URL },
    );

    expect(result).toEqual({ configured: true, artist: null });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("rejects a non-artist Spotify URL", async () => {
    const spotify = makeSpotify(async () => artist);
    await expect(
      getSpotifyArtist(
        { musicStats: spotify },
        { urlOrId: `https://open.spotify.com/track/${ARTIST_ID}` },
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "invalid_spotify_artist",
    });
    expect(spotify.getArtist).not.toHaveBeenCalled();
  });

  it("rejects a non-Spotify URL", async () => {
    const spotify = makeSpotify(async () => artist);
    await expect(
      getSpotifyArtist({ musicStats: spotify }, { urlOrId: "https://evil.example/x" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "invalid_spotify_artist",
    });
  });

  it("swallows a live Spotify failure, reports it, and returns artist:null", async () => {
    const boom = new Error("Spotify 503");
    const spotify = makeSpotify(async () => {
      throw boom;
    });
    const reportError = vi.fn();

    const result = await getSpotifyArtist(
      { musicStats: spotify, reportError },
      { urlOrId: ARTIST_URL },
    );

    expect(result).toEqual({ configured: true, artist: null });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "getSpotifyArtist" },
      extra: { artistId: ARTIST_ID },
    });
  });

  it("a throwing reporter never breaks the null fallback", async () => {
    const spotify = makeSpotify(async () => {
      throw new Error("down");
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry down too");
    });

    await expect(
      getSpotifyArtist({ musicStats: spotify, reportError }, { urlOrId: ARTIST_URL }),
    ).resolves.toEqual({ configured: true, artist: null });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("still degrades when reportError is not wired", async () => {
    const spotify = makeSpotify(async () => {
      throw new Error("down");
    });
    const result = await getSpotifyArtist({ musicStats: spotify }, { urlOrId: ARTIST_URL });
    expect(result).toEqual({ configured: true, artist: null });
  });
});
