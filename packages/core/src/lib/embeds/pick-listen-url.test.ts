import { describe, expect, it } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { pickListenUrl, toMusicListenUrl } from "./pick-listen-url";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SPOTIFY_TRACK = "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC";
const SPOTIFY_ARTIST = "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF";
const SOUNDCLOUD_TRACK = "https://soundcloud.com/forss/flickermood";
const SOUNDCLOUD_USER = "https://soundcloud.com/forss";
const APPLE_ALBUM = "https://music.apple.com/us/album/abbey-road/1441164426";
const YOUTUBE_VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const BANDCAMP_ALBUM = "https://artist.bandcamp.com/album/example-album";

let nextId = 0;
function block(kind: string, data: unknown): PageBlockRecord {
  nextId += 1;
  return {
    id: `block-${nextId}`,
    pageId: "page-1",
    kind,
    orderIndex: nextId,
    data,
    visible: true,
  };
}

const tracksBlock = (urls: unknown[]) =>
  block("tracks", { tracks: urls.map((url) => ({ url, title: "t" })) });
const musicBlock = (urls: unknown[]) =>
  block("music", { embeds: urls.map((url) => ({ url })) });
const linksBlock = (urls: unknown[]) =>
  block("links", { links: urls.map((url) => ({ label: "l", url })) });

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("pickListenUrl", () => {
  it("returns null for empty input", () => {
    expect(pickListenUrl([])).toBeNull();
  });

  describe("priority order", () => {
    it("prefers tracks over music over links", () => {
      const blocks = [
        linksBlock([SPOTIFY_ARTIST]),
        musicBlock([APPLE_ALBUM]),
        tracksBlock([SOUNDCLOUD_TRACK]),
      ];
      expect(pickListenUrl(blocks)).toBe(SOUNDCLOUD_TRACK);
    });

    it("falls back to music when tracks yields nothing playable", () => {
      const blocks = [
        tracksBlock([BANDCAMP_ALBUM]), // link renderMode — not inline-playable
        musicBlock([APPLE_ALBUM]),
        linksBlock([SPOTIFY_ARTIST]),
      ];
      expect(pickListenUrl(blocks)).toBe(APPLE_ALBUM);
    });

    it("falls back to links when tracks and music are empty", () => {
      const blocks = [tracksBlock([]), musicBlock([]), linksBlock([SPOTIFY_ARTIST])];
      expect(pickListenUrl(blocks)).toBe(SPOTIFY_ARTIST);
    });

    it("takes the first playable url within a block, skipping unparseable ones", () => {
      const blocks = [
        tracksBlock(["not a url", "https://evil.example/track", SPOTIFY_TRACK]),
      ];
      expect(pickListenUrl(blocks)).toBe(SPOTIFY_TRACK);
    });

    it("scans multiple blocks of the same kind in stored order", () => {
      const blocks = [tracksBlock(["nope"]), tracksBlock([SOUNDCLOUD_TRACK])];
      expect(pickListenUrl(blocks)).toBe(SOUNDCLOUD_TRACK);
    });
  });

  describe("provider rules", () => {
    it("tracks/music blocks accept any iframe provider (YouTube included)", () => {
      expect(pickListenUrl([tracksBlock([YOUTUBE_VIDEO])])).toBe(YOUTUBE_VIDEO);
      expect(pickListenUrl([musicBlock([YOUTUBE_VIDEO])])).toBe(YOUTUBE_VIDEO);
    });

    it("links block rejects YouTube (not a music provider)", () => {
      expect(pickListenUrl([linksBlock([YOUTUBE_VIDEO])])).toBeNull();
    });

    it("links block rejects Bandcamp (link renderMode, not inline-playable)", () => {
      expect(pickListenUrl([linksBlock([BANDCAMP_ALBUM])])).toBeNull();
    });

    it("links block accepts a Spotify ARTIST profile url", () => {
      expect(pickListenUrl([linksBlock([SPOTIFY_ARTIST])])).toBe(SPOTIFY_ARTIST);
    });

    it("links block accepts a SoundCloud user profile url", () => {
      expect(pickListenUrl([linksBlock([SOUNDCLOUD_USER])])).toBe(
        SOUNDCLOUD_USER,
      );
    });

    it("links block skips non-music urls and picks a later music one", () => {
      const blocks = [
        linksBlock([
          "https://instagram.com/somebody",
          YOUTUBE_VIDEO,
          SPOTIFY_ARTIST,
        ]),
      ];
      expect(pickListenUrl(blocks)).toBe(SPOTIFY_ARTIST);
    });
  });

  describe("malformed data never throws", () => {
    it("skips blocks with null / non-object / array data", () => {
      const blocks = [
        block("tracks", null),
        block("music", "garbage"),
        block("links", [1, 2, 3]),
        linksBlock([SPOTIFY_ARTIST]),
      ];
      expect(pickListenUrl(blocks)).toBe(SPOTIFY_ARTIST);
    });

    it("skips non-array tracks / embeds / links fields", () => {
      const blocks = [
        block("tracks", { tracks: "nope" }),
        block("music", { embeds: { url: SPOTIFY_TRACK } }),
        block("links", { links: 42 }),
      ];
      expect(pickListenUrl(blocks)).toBeNull();
    });

    it("skips non-object items and missing/empty urls", () => {
      const blocks = [
        tracksBlock([]),
        block("tracks", { tracks: [null, "str", { title: "no url" }, { url: "" }] }),
        block("music", { embeds: [{ url: 7 }] }),
      ];
      expect(pickListenUrl(blocks)).toBeNull();
    });

    it("ignores unrelated block kinds", () => {
      const blocks = [
        block("bio", { text: SPOTIFY_TRACK }),
        block("video", { embeds: [{ url: SPOTIFY_TRACK }] }),
      ];
      expect(pickListenUrl(blocks)).toBeNull();
    });
  });

  it("returns the canonical parser url (junk query params stripped)", () => {
    const dirty = `${SPOTIFY_TRACK}?si=abc123&utm_source=share`;
    expect(pickListenUrl([tracksBlock([dirty])])).toBe(SPOTIFY_TRACK);
  });
});

describe("toMusicListenUrl", () => {
  it("accepts music-provider iframe embeds and canonicalizes", () => {
    expect(toMusicListenUrl(SPOTIFY_ARTIST)).toBe(SPOTIFY_ARTIST);
    expect(toMusicListenUrl(SOUNDCLOUD_USER)).toBe(SOUNDCLOUD_USER);
    expect(toMusicListenUrl(APPLE_ALBUM)).toBe(APPLE_ALBUM);
    expect(toMusicListenUrl(`${SPOTIFY_ARTIST}?si=xyz`)).toBe(SPOTIFY_ARTIST);
  });

  it("rejects non-music providers, link-mode providers, and junk", () => {
    expect(toMusicListenUrl(YOUTUBE_VIDEO)).toBeNull();
    expect(toMusicListenUrl(BANDCAMP_ALBUM)).toBeNull();
    expect(toMusicListenUrl("https://example.com/band")).toBeNull();
    expect(toMusicListenUrl(null)).toBeNull();
    expect(toMusicListenUrl(undefined)).toBeNull();
  });
});
