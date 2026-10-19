import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";

import { createSpotifyAdapter } from "./spotify-adapter";

// ── Test helpers ─────────────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const TOKEN_BODY = {
  access_token: "tok_abc",
  token_type: "Bearer",
  expires_in: 3600,
};

const ARTIST_BODY = {
  id: "0TnOYISbd1XYRBk9myaseg",
  name: "Test Artist",
  images: [
    { url: "https://i.scdn.co/small.jpg", width: 160, height: 160 },
    { url: "https://i.scdn.co/large.jpg", width: 640, height: 640 },
    { url: "https://i.scdn.co/mid.jpg", width: 320, height: 320 },
  ],
  genres: ["indie", "folk"],
  followers: { total: 12345 },
  popularity: 57,
  external_urls: { spotify: "https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg" },
};

const TOP_TRACKS_BODY = {
  tracks: [
    {
      id: "track1",
      name: "Song One",
      preview_url: "https://p.scdn.co/mp3/1",
      external_urls: { spotify: "https://open.spotify.com/track/track1" },
    },
    {
      id: "track2",
      name: "Song Two",
      preview_url: null,
      external_urls: { spotify: "https://open.spotify.com/track/track2" },
    },
  ],
};

const ARTIST_ID = "0TnOYISbd1XYRBk9myaseg";

/** Mutable fake clock for token-expiry math. */
function fakeClock(startMs = 0): ClockPort & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Route by URL: token endpoint, artist endpoint, top-tracks endpoint. */
function routeDefault(url: string): Response {
  if (url.includes("accounts.spotify.com")) return jsonResponse(200, TOKEN_BODY);
  if (url.includes("/top-tracks")) return jsonResponse(200, TOP_TRACKS_BODY);
  if (url.includes("/artists/")) return jsonResponse(200, ARTIST_BODY);
  throw new Error(`unexpected url ${url}`);
}

function tokenFetchCount(): number {
  return fetchMock.mock.calls.filter((c) =>
    String(c[0]).includes("accounts.spotify.com"),
  ).length;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("createSpotifyAdapter", () => {
  it("fetches an artist with the largest image, genres, followers, popularity, top tracks", async () => {
    fetchMock.mockImplementation(async (url: string) => routeDefault(url));
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    const artist = await adapter.getArtist(ARTIST_ID);

    expect(artist).toEqual({
      source: "spotify",
      providerArtistId: ARTIST_ID,
      name: "Test Artist",
      imageUrl: "https://i.scdn.co/large.jpg", // largest by area
      genres: ["indie", "folk"],
      followers: 12345,
      popularity: 57,
      monthlyListeners: null,
      externalUrl: `https://open.spotify.com/artist/${ARTIST_ID}`,
      topTracks: [
        {
          name: "Song One",
          previewUrl: "https://p.scdn.co/mp3/1",
          externalUrl: "https://open.spotify.com/track/track1",
        },
        {
          name: "Song Two",
          previewUrl: null,
          externalUrl: "https://open.spotify.com/track/track2",
        },
      ],
    });
  });

  it("sends a Basic auth header to the token endpoint and never the secret to the API", async () => {
    fetchMock.mockImplementation(async (url: string) => routeDefault(url));
    const adapter = createSpotifyAdapter({
      clientId: "myid",
      clientSecret: "mysecret",
      clock: fakeClock(),
    });

    await adapter.getArtist(ARTIST_ID);

    const tokenCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("accounts.spotify.com"),
    );
    const expected = Buffer.from("myid:mysecret").toString("base64");
    expect(tokenCall?.[1].headers.Authorization).toBe(`Basic ${expected}`);
    expect(tokenCall?.[1].body).toBe("grant_type=client_credentials");

    const artistCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/artists/"),
    );
    expect(artistCall?.[1].headers.Authorization).toBe("Bearer tok_abc");
  });

  it("caches the token across calls and refetches after expiry", async () => {
    fetchMock.mockImplementation(async (url: string) => routeDefault(url));
    const clock = fakeClock();
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock,
    });

    await adapter.getArtist(ARTIST_ID);
    expect(tokenFetchCount()).toBe(1);

    // Second call well within the token lifetime → reuse.
    await adapter.getArtist(ARTIST_ID);
    expect(tokenFetchCount()).toBe(1);

    // Advance past expiry (3600s - 30s skew) → refetch.
    clock.advance(3600_000);
    await adapter.getArtist(ARTIST_ID);
    expect(tokenFetchCount()).toBe(2);
  });

  it("returns null for a 404 artist", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/artists/")) return jsonResponse(404, {});
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    expect(await adapter.getArtist(ARTIST_ID)).toBeNull();
  });

  it("refreshes the token once and retries on a 401", async () => {
    let artistCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/top-tracks")) return jsonResponse(200, TOP_TRACKS_BODY);
      if (url.includes("/artists/")) {
        artistCalls += 1;
        // First artist hit → 401 (stale token); retry → success.
        return artistCalls === 1
          ? jsonResponse(401, { error: { status: 401 } })
          : jsonResponse(200, ARTIST_BODY);
      }
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    const artist = await adapter.getArtist(ARTIST_ID);

    expect(artist?.name).toBe("Test Artist");
    expect(tokenFetchCount()).toBe(2); // initial + forced refresh
    expect(artistCalls).toBe(2); // initial 401 + retry
  });

  it("still returns the artist when the top-tracks fetch fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/top-tracks")) return jsonResponse(500, {});
      if (url.includes("/artists/")) return jsonResponse(200, ARTIST_BODY);
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    const artist = await adapter.getArtist(ARTIST_ID);
    expect(artist?.name).toBe("Test Artist");
    expect(artist?.topTracks).toBeUndefined();
  });

  it("still returns the artist when the top-tracks fetch throws", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/top-tracks")) throw new Error("network");
      if (url.includes("/artists/")) return jsonResponse(200, ARTIST_BODY);
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    const artist = await adapter.getArtist(ARTIST_ID);
    expect(artist?.topTracks).toBeUndefined();
  });

  it("throws on a non-404 error status from the artist endpoint", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/artists/")) return jsonResponse(500, {});
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    await expect(adapter.getArtist(ARTIST_ID)).rejects.toThrow(/HTTP 500/);
  });

  it("rejects an invalid artist id without any network call (SSRF guard)", async () => {
    fetchMock.mockImplementation(async (url: string) => routeDefault(url));
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    expect(await adapter.getArtist("../evil/path")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null image when the artist has no images", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("accounts.spotify.com"))
        return jsonResponse(200, TOKEN_BODY);
      if (url.includes("/top-tracks")) return jsonResponse(200, { tracks: [] });
      if (url.includes("/artists/"))
        return jsonResponse(200, { ...ARTIST_BODY, images: [] });
      throw new Error(`unexpected url ${url}`);
    });
    const adapter = createSpotifyAdapter({
      clientId: "id",
      clientSecret: "secret",
      clock: fakeClock(),
    });

    const artist = await adapter.getArtist(ARTIST_ID);
    expect(artist?.imageUrl).toBeNull();
  });
});
