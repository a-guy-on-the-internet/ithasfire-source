import { describe, expect, it } from "vitest";
import type { ProseMirrorDoc } from "@th/schema";

import { proseMirrorDocToHtml } from "../prose-utils";

/**
 * renderHTML hardening — hostile doc JSON through the generateHTML path.
 *
 * Event bodies can be proposed by anonymous visitors, and the richText path
 * of eventBodyToHtml feeds stored ProseMirror JSON straight into these
 * extensions' renderHTML.  The DOMSerializer escapes attribute values, so
 * breakout isn't possible — but scheme validation (media-embed href, audio
 * src) and width constraining (image figure style) are enforced by the
 * extensions themselves and covered here.
 *
 * Note: most attribute-level renderHTML emits raw (escaped) values into
 * data-* attributes that are inert. The exception is `data-source-url`: the
 * public audio-download button treats it as a navigable target (fetch +
 * window.open fallback), so AudioBlock scheme-checks it with `safeHref` and
 * the assertions below verify a hostile scheme is neutralized to `#`.
 */

/** zeed-dom (@tiptap/html under Node) stamps xmlns on every element. */
const stripNs = (html: string) =>
  html.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, "");

function docWith(node: Record<string, unknown>): ProseMirrorDoc {
  return { type: "doc", content: [node] };
}

describe("MediaEmbed renderHTML href validation", () => {
  it("neutralizes javascript: sourceUrl to #", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "mediaEmbed",
        attrs: {
          sourceUrl: "javascript:alert(1)",
          embedUrl: "javascript:alert(2)",
          externalId: "x",
          renderMode: "link",
        },
      }),
    );

    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="javascript:');
  });

  it("neutralizes a hostile embedUrl fallback when sourceUrl is empty", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "mediaEmbed",
        attrs: {
          sourceUrl: "",
          embedUrl: "data:text/html,<script>alert(1)</script>",
          externalId: "x",
          renderMode: "link",
        },
      }),
    );

    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="data:');
  });

  it("preserves same-origin relative sourceUrls", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "mediaEmbed",
        attrs: {
          sourceUrl: "/events/foo-bar",
          embedUrl: "",
          externalId: "x",
          renderMode: "link",
        },
      }),
    );

    expect(html).toContain('href="/events/foo-bar"');
  });

  it("preserves safe https sourceUrls", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "mediaEmbed",
        attrs: {
          sourceUrl: "https://youtu.be/abc123",
          embedUrl: "https://www.youtube.com/embed/abc123",
          externalId: "abc123",
          renderMode: "iframe",
        },
      }),
    );

    expect(html).toContain('href="https://youtu.be/abc123"');
  });
});

describe("ImageBlock renderHTML width constraining", () => {
  it("drops CSS-injection widths back to 100%", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "imageBlock",
        attrs: {
          imageId: "img1",
          alt: "hi",
          width: "13px;background:url(//x)",
        },
      }),
      { img1: "https://cdn.example.com/x.jpg" },
    );

    // The raw value still round-trips through the inert data-width attribute
    // (serializer-escaped); the style attribute must not pick it up.
    expect(html).toContain(
      'style="margin: 16px auto; width: 100%; max-width: 100%;"',
    );
    expect(html).not.toContain("width: 13px");
  });

  it("preserves the percent and px widths the editor produces", () => {
    const pct = proseMirrorDocToHtml(
      docWith({
        type: "imageBlock",
        attrs: { imageId: "img1", width: "50%" },
      }),
      { img1: "https://cdn.example.com/x.jpg" },
    );
    expect(pct).toContain("width: 50%;");

    const px = proseMirrorDocToHtml(
      docWith({
        type: "imageBlock",
        attrs: { imageId: "img1", width: "300px" },
      }),
      { img1: "https://cdn.example.com/x.jpg" },
    );
    expect(px).toContain("width: 300px;");
  });
});

describe("ImageBlock renderHTML src validation", () => {
  it("neutralizes a doc-baked javascript: src when no imageUrlMap is given", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "imageBlock",
        attrs: {
          imageId: "img1",
          alt: "hi",
          src: "javascript:alert(1)",
        },
      }),
    );

    expect(html).toContain('src="#"');
    expect(html).not.toContain('src="javascript:');
  });
});

describe("AudioBlock renderHTML src validation", () => {
  it("neutralizes a doc-baked javascript: sourceUrl to #", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "javascript:alert(1)",
        },
      }),
    );

    expect(html).toContain('src="#"');
    expect(html).not.toContain('src="javascript:');
  });

  it("neutralizes a hostile hlsPlaylistUrl fallback to #", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          hlsPlaylistUrl: "data:audio/mpeg,evil",
        },
      }),
    );

    expect(html).toContain('src="#"');
    expect(html).not.toContain('src="data:');
  });

  it("neutralizes a hostile javascript: sourceUrl in the navigable data-source-url", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          allowDownload: true,
          sourceUrl: "javascript:alert(document.cookie)",
        },
      }),
    );

    // The download button reads data-source-url as a navigable target, so the
    // hostile scheme must be neutralized to # — never emitted verbatim.
    expect(html).toContain('data-source-url="#"');
    expect(html).not.toContain("javascript:");
  });

  it("neutralizes a hostile data: sourceUrl in the navigable data-source-url", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          allowDownload: true,
          sourceUrl: "data:audio/mpeg;base64,ZXZpbA==",
        },
      }),
    );

    expect(html).toContain('data-source-url="#"');
    expect(html).not.toContain('data-source-url="data:');
  });

  it("preserves server-resolved audioUrlMap sourceUrls", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: { audioUploadId: "a1", title: "Track" },
      }),
      undefined,
      { a1: { sourceUrl: "https://cdn.example.com/t.mp3", status: "READY" } },
    );

    expect(html).toContain('src="https://cdn.example.com/t.mp3"');
    // The direct file must also be exposed as data-source-url so the public
    // hydrator can target it for downloads (never the HLS playlist).
    expect(html).toContain(
      'data-source-url="https://cdn.example.com/t.mp3"',
    );
  });

  /**
   * `sourceUrl` is a presigned credential the server mints per read. Older
   * saved documents have one baked into their attrs. When the server HAS
   * resolved the upload and deliberately returned no URL — object swept,
   * signing failed — the baked copy is a dead credential, and because
   * renderHTML prefers sourceUrl over hlsPlaylistUrl it would also block the
   * HLS fallback. Presence in the map, not truthiness, must decide.
   */
  it("drops a stale baked sourceUrl when the server resolved it to null", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "https://r2.example.com/expired.mp3?X-Amz-Signature=old",
        },
      }),
      undefined,
      {
        a1: {
          sourceUrl: null,
          hlsPlaylistUrl: "https://cdn.example.com/x.m3u8",
          status: "READY",
        },
      },
    );

    expect(html).not.toContain("expired.mp3");
    // …and the HLS fallback is now reachable.
    expect(html).toContain("x.m3u8");
  });

  it("keeps a baked sourceUrl when the server said nothing about that upload", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "https://cdn.example.com/baked.mp3",
        },
      }),
      undefined,
      // Empty map — e.g. the audio lookup failed entirely. Better to try the
      // baked URL than to render nothing.
      {},
    );

    expect(html).toContain("baked.mp3");
  });
});

describe("AudioBlock renderHTML allowDownload attribute", () => {
  it("emits data-allow-download only when true", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "https://cdn.example.com/t.mp3",
          allowDownload: true,
        },
      }),
    );

    expect(html).toContain('data-allow-download="true"');
  });

  it("omits data-allow-download when false", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "https://cdn.example.com/t.mp3",
          allowDownload: false,
        },
      }),
    );

    expect(html).not.toContain("data-allow-download");
  });

  it("defaults to no download flag when the attribute is absent", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: {
          audioUploadId: "a1",
          title: "Track",
          sourceUrl: "https://cdn.example.com/t.mp3",
        },
      }),
    );

    expect(html).not.toContain("data-allow-download");
  });

  it("survives the audioUrlMap resolution pass", () => {
    const html = proseMirrorDocToHtml(
      docWith({
        type: "audioBlock",
        attrs: { audioUploadId: "a1", title: "Track", allowDownload: true },
      }),
      undefined,
      { a1: { sourceUrl: "https://cdn.example.com/t.mp3", status: "READY" } },
    );

    expect(html).toContain('data-allow-download="true"');
  });
});

describe("ImageBlock renderHTML caption escaping", () => {
  const map = { img1: "https://cdn.example.com/x.jpg" };
  const withCaption = (caption: unknown, imageUrlMap?: Record<string, string>) =>
    stripNs(
      proseMirrorDocToHtml(
        docWith({ type: "imageBlock", attrs: { imageId: "img1", caption } }),
        imageUrlMap,
      ),
    );

  // Both renderHTML branches: resolved src (page, Preview) and no map.
  for (const [label, imageUrlMap] of [
    ["resolved src", map],
    ["no imageUrlMap", undefined],
  ] as const) {
    describe(label, () => {
      it("escapes a <script> caption as text", () => {
        const html = withCaption("<script>alert(1)</script>", imageUrlMap);
        expect(html).toContain(
          "<figcaption>&lt;script&gt;alert(1)&lt;/script&gt;</figcaption>",
        );
        expect(html).not.toContain("<script");
      });

      it('escapes an attribute-breakout caption ("><img onerror>)', () => {
        const html = withCaption('"><img src=x onerror=alert(1)>', imageUrlMap);
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;</figcaption>");
        // The only <img> is the image itself.
        expect(html.match(/<img/g)).toHaveLength(1);
      });

      it("escapes an ampersand", () => {
        expect(withCaption("Salt & Pepper", imageUrlMap)).toContain(
          "<figcaption>Salt &amp; Pepper</figcaption>",
        );
      });

      it("renders no <figcaption> for an empty, whitespace or non-string caption", () => {
        for (const caption of [null, "", "   \n\t ", 42, { a: 1 }]) {
          expect(withCaption(caption, imageUrlMap)).not.toContain("figcaption");
        }
      });

      it("cuts a caption to one line of at most 200 characters", () => {
        const html = withCaption(`line one\nline two ${"x".repeat(400)}`, imageUrlMap);
        const text = /<figcaption>([^<]*)<\/figcaption>/.exec(html)?.[1] ?? "";
        expect(text.startsWith("line one line two x")).toBe(true);
        expect(text).toHaveLength(200);
      });
    });
  }
});
