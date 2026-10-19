import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveAudioFilename, downloadAudioFile } from "../downloadAudioFile";

describe("deriveAudioFilename", () => {
  it("prefers a sanitized title with the URL's extension", () => {
    expect(
      deriveAudioFilename("https://cdn.example.com/x/abc123.mp3", "My Set!"),
    ).toBe("My_Set.mp3");
  });

  it("falls back to the URL basename when no title is given", () => {
    expect(
      deriveAudioFilename("https://cdn.example.com/audio/track-01.wav"),
    ).toBe("track-01.wav");
  });

  it("ignores query strings when deriving the extension and basename", () => {
    expect(
      deriveAudioFilename(
        "https://cdn.example.com/audio/song.m4a?sig=abc&exp=123",
      ),
    ).toBe("song.m4a");
  });

  it("strips an existing extension from the title before re-adding one", () => {
    expect(
      deriveAudioFilename("https://cdn.example.com/a.mp3", "demo.mp3"),
    ).toBe("demo.mp3");
  });

  it("defaults the extension to mp3 when the URL has none", () => {
    expect(
      deriveAudioFilename("https://cdn.example.com/audio/stream", "Live"),
    ).toBe("Live.mp3");
  });

  it("collapses unsafe characters and never yields an empty base", () => {
    expect(deriveAudioFilename("https://cdn.example.com/a.mp3", "///")).toBe(
      "audio.mp3",
    );
  });
});

describe("downloadAudioFile — scheme gate (stored-XSS defense)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const hostileUrls = [
    "javascript:alert(document.cookie)",
    "data:audio/mpeg;base64,ZXZpbA==",
    "blob:https://evil.example/abc",
    "file:///etc/passwd",
    "#", // safeHref-neutralized value that still passes the m3u8 gate
    "//evil.example/x.mp3", // protocol-relative
  ];

  it.each(hostileUrls)(
    "is a no-op for non-http(s) URL %s — no fetch, no window.open",
    async (url) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("x"));
      const openSpy = vi
        .spyOn(window, "open")
        .mockReturnValue(null);

      await downloadAudioFile(url, "Track");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it("falls back to window.open for a valid http(s) URL when fetch fails (CORS)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("CORS"));
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    await downloadAudioFile("https://cdn.example.com/a.mp3", "Track");

    expect(openSpy).toHaveBeenCalledWith(
      "https://cdn.example.com/a.mp3",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
