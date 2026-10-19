import { describe, expect, it } from "vitest";
import type { ProseMirrorDoc } from "@th/schema";

import { proseMirrorDocToHtml, type AudioUrlMapEntry } from "../prose-utils";

/**
 * Which file the rendered `<audio src>` points at — the HTML the builder
 * Preview and the public event page hydrate into a player. It must match the
 * editor's node view (`sourceUrl || hlsPlaylistUrl`): the original upload
 * whenever it exists (Chrome/Firefox cannot play HLS in a plain <audio>), the
 * HLS playlist when it is the only URL, and the placeholder when neither is.
 */

const SOURCE = "https://minio.example.com/th-media/audio/au-1/original.mp3?sig=1";
const HLS = "https://cdn.example.com/audio/au-1/playlist.m3u8";

function doc(attrs: Record<string, unknown> = {}): ProseMirrorDoc {
  return {
    type: "doc",
    content: [
      {
        type: "audioBlock",
        attrs: { audioUploadId: "au-1", title: "Set", ...attrs },
      },
    ] as ProseMirrorDoc["content"],
  };
}

function audioSrc(html: string): string | null {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("audio")?.getAttribute("src") ?? null;
}

function render(entry: AudioUrlMapEntry, attrs?: Record<string, unknown>) {
  return proseMirrorDocToHtml(doc(attrs), {}, { "au-1": entry });
}

describe("audio block src selection", () => {
  it("FAILED transcode: plays the original file", () => {
    const html = render({ sourceUrl: SOURCE, hlsPlaylistUrl: null, status: "FAILED" });
    expect(audioSrc(html)).toBe(SOURCE);
    expect(html).toContain(`data-source-url="${SOURCE.replace(/&/g, "&amp;")}"`);
  });

  it("READY with both URLs: the original, as the editor does", () => {
    const html = render({ sourceUrl: SOURCE, hlsPlaylistUrl: HLS, status: "READY" });
    expect(audioSrc(html)).toBe(SOURCE);
  });

  it("HLS only (original unsignable): the playlist", () => {
    const html = render({ sourceUrl: null, hlsPlaylistUrl: HLS, status: "READY" });
    expect(audioSrc(html)).toBe(HLS);
  });

  it("empty-string original counts as missing and falls through to HLS", () => {
    const html = render({ sourceUrl: "", hlsPlaylistUrl: HLS, status: "READY" });
    expect(audioSrc(html)).toBe(HLS);
  });

  it("server resolved no original: a stale baked sourceUrl is not served", () => {
    const html = render(
      { sourceUrl: null, hlsPlaylistUrl: HLS, status: "READY" },
      { sourceUrl: "https://minio.example.com/expired.mp3" },
    );
    expect(audioSrc(html)).toBe(HLS);
  });

  it("nothing playable: placeholder, no <audio>", () => {
    const html = render({ sourceUrl: null, hlsPlaylistUrl: null, status: "TRANSCODING" });
    expect(audioSrc(html)).toBeNull();
    expect(html).toContain("Set");
  });

  it.each(["PENDING", "UPLOADED", "TRANSCODING"])(
    "untitled placeholder while %s says it is processing",
    (status) => {
      const html = render(
        { sourceUrl: null, hlsPlaylistUrl: null, status },
        { title: "" },
      );
      expect(audioSrc(html)).toBeNull();
      expect(html).toContain("Audio processing\u2026");
      expect(html).not.toContain("Audio unavailable");
    },
  );

  it.each(["FAILED", "READY"])(
    "untitled placeholder that will not resolve (%s, no URL) says unavailable",
    (status) => {
      const html = render(
        { sourceUrl: null, hlsPlaylistUrl: null, status },
        { title: "" },
      );
      expect(audioSrc(html)).toBeNull();
      expect(html).toContain("Audio unavailable");
      expect(html).not.toContain("processing");
    },
  );

  it("titled placeholder keeps its title in either state", () => {
    for (const status of ["TRANSCODING", "FAILED"]) {
      const html = render({ sourceUrl: null, hlsPlaylistUrl: null, status });
      expect(html).toContain(">Set<");
      expect(html).not.toContain("Audio processing");
      expect(html).not.toContain("Audio unavailable");
    }
  });

  it("hostile original scheme is still neutralised", () => {
    const html = render({
      sourceUrl: "javascript:alert(1)",
      hlsPlaylistUrl: null,
      status: "FAILED",
    });
    expect(audioSrc(html)).toBe("#");
  });
});
