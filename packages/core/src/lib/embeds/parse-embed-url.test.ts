import { describe, expect, it } from "vitest";

import { parseEmbedUrl } from "./parse-embed-url";
import { inferSizing } from "./providers";

describe("parseEmbedUrl", () => {
  describe("safety", () => {
    it("returns null for empty / non-string input", () => {
      expect(parseEmbedUrl("")).toBeNull();
      expect(parseEmbedUrl("   ")).toBeNull();
      expect(parseEmbedUrl(null as unknown as string)).toBeNull();
      expect(parseEmbedUrl(undefined as unknown as string)).toBeNull();
      expect(parseEmbedUrl(42 as unknown as string)).toBeNull();
      expect(parseEmbedUrl({} as unknown as string)).toBeNull();
    });

    it("rejects non-http(s) protocols", () => {
      expect(parseEmbedUrl("javascript:alert(1)")).toBeNull();
      expect(parseEmbedUrl("data:text/html,<script>1</script>")).toBeNull();
      expect(parseEmbedUrl("file:///etc/passwd")).toBeNull();
    });

    it("rejects protocol-relative URLs", () => {
      expect(parseEmbedUrl("//www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    });

    it("rejects iframe HTML strings (URLs only)", () => {
      expect(
        parseEmbedUrl(
          '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
        ),
      ).toBeNull();
    });

    it("rejects URLs that contain credentials", () => {
      expect(
        parseEmbedUrl("https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // YouTube
  // ───────────────────────────────────────────────────────────────────────
  describe("YouTube", () => {
    it("parses canonical watch URLs", () => {
      const result = parseEmbedUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
      expect(result).toMatchObject({
        provider: "youtube",
        externalId: "dQw4w9WgXcQ",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        kind: "video",
      });
    });

    it("parses youtu.be short URLs", () => {
      const result = parseEmbedUrl("https://youtu.be/dQw4w9WgXcQ");
      expect(result?.externalId).toBe("dQw4w9WgXcQ");
      expect(result?.embedUrl).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      );
    });

    it("parses /embed/ and /shorts/ paths", () => {
      expect(
        parseEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")?.externalId,
      ).toBe("dQw4w9WgXcQ");
      expect(
        parseEmbedUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")?.externalId,
      ).toBe("dQw4w9WgXcQ");
    });

    it("preserves safe query params (start/end/list)", () => {
      const result = parseEmbedUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=30&end=60&list=PLaaaaaaaa1",
      );
      expect(result?.embedUrl).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30&end=60&list=PLaaaaaaaa1",
      );
    });

    it("strips unsafe / unknown query params", () => {
      const result = parseEmbedUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&onerror=alert(1)",
      );
      expect(result?.embedUrl).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      );
    });

    it("rejects hostname spoofing", () => {
      expect(
        parseEmbedUrl("https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ"),
      ).toBeNull();
      expect(
        parseEmbedUrl("https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBeNull();
    });

    it("rejects malformed video ids", () => {
      expect(
        parseEmbedUrl("https://www.youtube.com/watch?v=tooshort"),
      ).toBeNull();
      expect(
        parseEmbedUrl("https://www.youtube.com/watch?v=<script>aa"),
      ).toBeNull();
      expect(parseEmbedUrl("https://www.youtube.com/watch?v=")).toBeNull();
      expect(parseEmbedUrl("https://www.youtube.com/watch")).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Vimeo
  // ───────────────────────────────────────────────────────────────────────
  describe("Vimeo", () => {
    it("parses canonical vimeo.com URLs", () => {
      const result = parseEmbedUrl("https://vimeo.com/76979871");
      expect(result).toMatchObject({
        provider: "vimeo",
        externalId: "76979871",
        embedUrl: "https://player.vimeo.com/video/76979871",
      });
    });

    it("parses player.vimeo.com URLs", () => {
      expect(
        parseEmbedUrl("https://player.vimeo.com/video/76979871")?.externalId,
      ).toBe("76979871");
    });

    it("parses /{user}/{id} URLs", () => {
      expect(
        parseEmbedUrl("https://vimeo.com/user123/76979871")?.externalId,
      ).toBe("76979871");
    });

    it("rejects non-numeric ids and missing ids", () => {
      expect(parseEmbedUrl("https://vimeo.com/abcde")).toBeNull();
      expect(parseEmbedUrl("https://vimeo.com/")).toBeNull();
    });

    it("rejects spoofed vimeo hostnames", () => {
      expect(parseEmbedUrl("https://vimeo.com.evil.com/76979871")).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Spotify
  // ───────────────────────────────────────────────────────────────────────
  describe("Spotify", () => {
    const trackId = "11dFghVXANMlKmJXsNCbNl"; // 22 chars

    it("parses track URLs", () => {
      const result = parseEmbedUrl(`https://open.spotify.com/track/${trackId}`);
      expect(result).toMatchObject({
        provider: "spotify",
        kind: "track",
        externalId: trackId,
        embedUrl: `https://open.spotify.com/embed/track/${trackId}`,
      });
    });

    it("parses album URLs with query params", () => {
      const result = parseEmbedUrl(
        `https://open.spotify.com/album/${trackId}?si=abc`,
      );
      expect(result?.kind).toBe("album");
      expect(result?.embedUrl).toBe(
        `https://open.spotify.com/embed/album/${trackId}`,
      );
    });

    it("parses /embed/ URLs", () => {
      const result = parseEmbedUrl(
        `https://open.spotify.com/embed/playlist/${trackId}`,
      );
      expect(result?.kind).toBe("playlist");
    });

    it("rejects invalid kinds", () => {
      expect(
        parseEmbedUrl(`https://open.spotify.com/badkind/${trackId}`),
      ).toBeNull();
    });

    it("rejects malformed ids", () => {
      expect(parseEmbedUrl("https://open.spotify.com/track/short")).toBeNull();
      expect(
        parseEmbedUrl("https://open.spotify.com/track/<script>aa"),
      ).toBeNull();
      expect(parseEmbedUrl("https://open.spotify.com/track/")).toBeNull();
    });

    it("rejects spoofed hosts", () => {
      expect(
        parseEmbedUrl(`https://spotify.com.evil.com/track/${trackId}`),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Apple Music
  // ───────────────────────────────────────────────────────────────────────
  describe("Apple Music", () => {
    it("parses album URLs with slug", () => {
      const result = parseEmbedUrl(
        "https://music.apple.com/us/album/abbey-road/1441164426",
      );
      expect(result).toMatchObject({
        provider: "appleMusic",
        kind: "album",
        externalId: "1441164426",
        embedUrl:
          "https://embed.music.apple.com/us/album/abbey-road/1441164426",
      });
    });

    it("preserves country code (other than us)", () => {
      const result = parseEmbedUrl(
        "https://music.apple.com/gb/album/abbey-road/1441164426",
      );
      expect(result?.sourceUrl).toContain("/gb/");
      expect(result?.embedUrl).toContain("/gb/");
    });

    it("preserves ?i= track id query param", () => {
      const result = parseEmbedUrl(
        "https://music.apple.com/us/album/abbey-road/1441164426?i=1441164532",
      );
      expect(result?.embedUrl).toBe(
        "https://embed.music.apple.com/us/album/abbey-road/1441164426?i=1441164532",
      );
    });

    it("rejects invalid kinds", () => {
      expect(
        parseEmbedUrl(
          "https://music.apple.com/us/badkind/abbey-road/1441164426",
        ),
      ).toBeNull();
    });

    it("rejects non-numeric trailing id and bad country", () => {
      expect(
        parseEmbedUrl("https://music.apple.com/us/album/abbey-road/notanid"),
      ).toBeNull();
      expect(
        parseEmbedUrl(
          "https://music.apple.com/USA/album/abbey-road/1441164426",
        ),
      ).toBeNull();
    });

    it("rejects spoofed hosts", () => {
      expect(
        parseEmbedUrl(
          "https://music.apple.com.evil.com/us/album/abbey-road/1441164426",
        ),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // SoundCloud
  // ───────────────────────────────────────────────────────────────────────
  describe("SoundCloud", () => {
    it("parses track URLs", () => {
      const result = parseEmbedUrl("https://soundcloud.com/forss/flickermood");
      expect(result).toMatchObject({
        provider: "soundcloud",
        kind: "track",
        externalId: "forss/flickermood",
      });
      expect(
        result?.embedUrl.startsWith("https://w.soundcloud.com/player/?url="),
      ).toBe(true);
      expect(result?.embedUrl).toContain(
        encodeURIComponent("https://soundcloud.com/forss/flickermood"),
      );
    });

    it("parses set/playlist URLs", () => {
      const result = parseEmbedUrl(
        "https://soundcloud.com/forss/sets/soulhack",
      );
      expect(result?.kind).toBe("set");
    });

    it("rejects share-shortener host", () => {
      expect(parseEmbedUrl("https://on.soundcloud.com/abc123")).toBeNull();
    });

    it("parses user profile URLs (single segment) as kind 'user'", () => {
      const result = parseEmbedUrl("https://soundcloud.com/forss");
      expect(result).toMatchObject({
        provider: "soundcloud",
        kind: "user",
        externalId: "forss",
        sourceUrl: "https://soundcloud.com/forss",
        renderMode: "iframe",
      });
      // Same widget embed form as tracks/sets — the widget plays the user's
      // uploads when handed a profile URL.
      expect(
        result?.embedUrl.startsWith("https://w.soundcloud.com/player/?url="),
      ).toBe(true);
      expect(result?.embedUrl).toContain(
        encodeURIComponent("https://soundcloud.com/forss"),
      );
    });

    it("gives user profiles the taller playlist-style sizing", () => {
      expect(inferSizing("soundcloud", "user")).toEqual(
        inferSizing("soundcloud", "set"),
      );
      expect(inferSizing("soundcloud", "user")).not.toEqual(
        inferSizing("soundcloud", "track"),
      );
    });

    const SOUNDCLOUD_RESERVED = [
      "discover",
      "search",
      "stream",
      "upload",
      "you",
      "pages",
      "charts",
      "feed",
      "messages",
      "notifications",
      "settings",
      "terms-of-use",
      "imprint",
      "jobs",
      "logout",
      "signin",
      "popular",
      "tags",
    ];
    it.each(SOUNDCLOUD_RESERVED)(
      "rejects reserved single-segment path /%s",
      (seg) => {
        expect(parseEmbedUrl(`https://soundcloud.com/${seg}`)).toBeNull();
      },
    );

    it("rejects reserved paths case-insensitively", () => {
      expect(parseEmbedUrl("https://soundcloud.com/Discover")).toBeNull();
    });

    it("rejects user segments with disallowed characters or excess length", () => {
      expect(parseEmbedUrl("https://soundcloud.com/<script>")).toBeNull();
      expect(
        parseEmbedUrl(`https://soundcloud.com/${"a".repeat(129)}`),
      ).toBeNull();
    });

    it("rejects bare host without path", () => {
      expect(parseEmbedUrl("https://soundcloud.com/")).toBeNull();
    });

    it("rejects path segments with disallowed characters", () => {
      expect(parseEmbedUrl("https://soundcloud.com/forss/<script>")).toBeNull();
    });

    it("rejects spoofed hosts", () => {
      expect(
        parseEmbedUrl("https://soundcloud.com.evil.com/forss/flickermood"),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Bandcamp
  // ───────────────────────────────────────────────────────────────────────
  describe("Bandcamp", () => {
    it("parses album URLs", () => {
      const result = parseEmbedUrl(
        "https://artist.bandcamp.com/album/example-album",
      );
      expect(result).toMatchObject({
        provider: "bandcamp",
        kind: "album",
        externalId: "artist.bandcamp.com/album/example-album",
        sourceUrl: "https://artist.bandcamp.com/album/example-album",
        // v1 fallback: embedUrl mirrors the source URL until oEmbed lookup
        // resolves the iframe player id.
        embedUrl: "https://artist.bandcamp.com/album/example-album",
      });
    });

    it("parses track URLs", () => {
      const result = parseEmbedUrl(
        "https://artist.bandcamp.com/track/example-track",
      );
      expect(result?.kind).toBe("track");
    });

    it("rejects bare bandcamp.com (no artist subdomain)", () => {
      expect(
        parseEmbedUrl("https://bandcamp.com/album/example-album"),
      ).toBeNull();
    });

    it("rejects spoofed hosts", () => {
      expect(parseEmbedUrl("https://bandcamp.com.evil.com/album/x")).toBeNull();
    });

    it("rejects unknown kind segments", () => {
      expect(
        parseEmbedUrl("https://artist.bandcamp.com/merch/example"),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Cross-provider rejection
  // ───────────────────────────────────────────────────────────────────────
  describe("cross-provider rejection", () => {
    it("returns null for arbitrary http(s) URLs", () => {
      expect(parseEmbedUrl("https://example.com/something")).toBeNull();
      expect(parseEmbedUrl("https://twitter.com/foo/status/12345")).toBeNull();
      expect(parseEmbedUrl("https://www.instagram.com/p/abc123/")).toBeNull();
    });
  });

  describe("deterministic embed URL shapes", () => {
    const cases: Array<{ url: string; expected: string }> = [
      {
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        expected: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      },
      {
        url: "https://vimeo.com/76979871",
        expected: "https://player.vimeo.com/video/76979871",
      },
      {
        url: "https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl",
        expected: "https://open.spotify.com/embed/track/11dFghVXANMlKmJXsNCbNl",
      },
      {
        url: "https://music.apple.com/us/album/abbey-road/1441164426",
        expected:
          "https://embed.music.apple.com/us/album/abbey-road/1441164426",
      },
    ];
    it.each(cases)("$url → $expected", ({ url, expected }) => {
      expect(parseEmbedUrl(url)?.embedUrl).toBe(expected);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Spec 1 (parser & negatives) — coverage for the rows not already pinned
  // by the by-provider blocks above.
  // ────────────────────────────────────────────────────────────────────────
  describe("spec 1 — additional matrix coverage", () => {
    // ── A6, A7: YouTube non-video paths must reject ─────────────────────
    it("A6: rejects YouTube /live/ URLs", () => {
      expect(
        parseEmbedUrl("https://www.youtube.com/live/abc123XYZ_-"),
      ).toBeNull();
    });
    it("A7: rejects YouTube channel/handle URLs", () => {
      expect(parseEmbedUrl("https://www.youtube.com/@somechannel")).toBeNull();
      expect(parseEmbedUrl("https://www.youtube.com/c/somechannel")).toBeNull();
      expect(parseEmbedUrl("https://www.youtube.com/user/someuser")).toBeNull();
    });

    // ── A8: case-insensitive host normalisation ─────────────────────────
    it("A8: accepts mixed-case hosts (host normalised to lowercase)", () => {
      const parsed = parseEmbedUrl("https://YOUTUBE.com/watch?v=dQw4w9WgXcQ");
      expect(parsed?.provider).toBe("youtube");
      expect(parsed?.embedUrl).toContain(
        "youtube-nocookie.com/embed/dQw4w9WgXcQ",
      );
    });

    // ── A23: Apple Music slug-less album URL ─────────────────────────────
    it("A23: accepts Apple Music slug-less album URLs", () => {
      const parsed = parseEmbedUrl(
        "https://music.apple.com/us/album/617154241",
      );
      expect(parsed?.provider).toBe("appleMusic");
      expect(parsed?.externalId).toBe("617154241");
      expect(parsed?.embedUrl).toBe(
        "https://embed.music.apple.com/us/album/617154241",
      );
    });

    // ── A27 (superseded by lineup-listen-embeds spec §1): SoundCloud
    // user-only paths are now accepted as kind "user"; only reserved site
    // paths reject. ─────────────────────────────────────────────────────
    it("A27': accepts SoundCloud user-only paths but rejects reserved ones", () => {
      expect(parseEmbedUrl("https://soundcloud.com/forss")?.kind).toBe("user");
      expect(parseEmbedUrl("https://soundcloud.com/discover")).toBeNull();
    });

    // ── A31: Bandcamp custom-domain hosts must reject (only *.bandcamp.com) ─
    it("A31: rejects Bandcamp custom-domain hosts", () => {
      expect(
        parseEmbedUrl("https://music.monstercat.com/album/foo"),
      ).toBeNull();
    });

    // ── B11: a URL surrounded by smart quotes (Word/Slack paste) ────────
    it("B11: rejects URLs wrapped in smart quotes (paste from rich text)", () => {
      // The smart-quote characters fail `new URL()` — so they parse to null
      // rather than being silently stripped. That's intended: pasted text
      // with surrounding punctuation isn't a URL token.
      expect(
        parseEmbedUrl("\u201chttps://vimeo.com/76979871\u201d"),
      ).toBeNull();
    });

    // ── B12: very long URL must not crash; pad spec is via `&list=` ─────
    it("B12: very long URL with junk extra params doesn't crash; long `list=` rejected by safe-id length cap", () => {
      const padded =
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=" + "x".repeat(2048);
      // Parser must not throw and must drop the unsafe long list.
      const parsed = parseEmbedUrl(padded);
      expect(parsed?.provider).toBe("youtube");
      expect(parsed?.externalId).toBe("dQw4w9WgXcQ");
      expect(parsed?.embedUrl).not.toContain("list=");
    });

    // ── B13: a `#fragment` after a valid path must not break the parse ──
    it("B13: ignores #fragments after a valid YouTube URL", () => {
      const parsed = parseEmbedUrl(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=30",
      );
      expect(parsed?.provider).toBe("youtube");
      expect(parsed?.embedUrl).toBe(
        "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      );
    });

    // ── B14: IDN / Unicode hosts are not in any allowlist → reject ──────
    it("B14: rejects IDN / Unicode hosts", () => {
      // The `URL` constructor will punycode this to xn-- form, which is not
      // in any provider host allowlist.
      expect(
        parseEmbedUrl("https://中文.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBeNull();
    });

    // ── A14, A15, A16, A17: Spotify kind variants beyond track ──────────
    it("A14-A17: accepts Spotify album / playlist / episode / show / artist", () => {
      const id = "0".repeat(22);
      for (const kind of ["album", "playlist", "episode", "show", "artist"]) {
        const parsed = parseEmbedUrl(`https://open.spotify.com/${kind}/${id}`);
        expect(parsed?.provider).toBe("spotify");
        expect(parsed?.kind).toBe(kind);
        expect(parsed?.embedUrl).toBe(
          `https://open.spotify.com/embed/${kind}/${id}`,
        );
      }
    });
  });
});
