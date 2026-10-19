import { describe, expect, it } from "vitest";

import { prosemirrorDocSchema } from "./index";

/**
 * Regression coverage for `bodyDoc` schema tightening: pre-existing prose
 * documents (event descriptions, announcement bodies) must continue to
 * validate through the strict `prosemirrorDocSchema` after the
 * `z.unknown() → prosemirrorDocSchema` migration in send-announcement.
 */
describe("prosemirrorDocSchema — legacy doc compatibility", () => {
  it("accepts an empty doc", () => {
    const result = prosemirrorDocSchema.safeParse({ type: "doc", content: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a basic paragraph doc", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello world" }] },
      ],
    };
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts marks: bold, italic, link, highlight", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi ", marks: [{ type: "bold" }] },
            {
              type: "text",
              text: "linked",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
            { type: "text", text: " yo", marks: [{ type: "italic" }] },
            { type: "text", text: " hl", marks: [{ type: "highlight" }] },
          ],
        },
      ],
    };
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts headings, lists, blockquotes, horizontal rule", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "one" }] },
              ],
            },
          ],
        },
        {
          type: "orderedList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "two" }] },
              ],
            },
          ],
        },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "quote" }] },
          ],
        },
        { type: "horizontalRule" },
      ],
    };
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts imageBlock and audioBlock atom nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "imageBlock",
          attrs: {
            imageId: "img-123",
            alt: "photo",
            align: "center",
            width: "100%",
            float: "none",
          },
        },
        {
          type: "audioBlock",
          attrs: {
            audioUploadId: "aud-456",
            sourceUrl: "https://cdn.example.com/audio.mp3",
            status: "READY",
          },
        },
      ],
    };
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("accepts a doc that mixes prose, image, audio, AND media-embed", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Watch the trailer:" }],
        },
        {
          type: "mediaEmbed",
          attrs: {
            provider: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            externalId: "dQw4w9WgXcQ",
            renderMode: "iframe",
            kind: "video",
            aspectRatio: "16/9",
          },
        },
        {
          type: "imageBlock",
          attrs: {
            imageId: "img-1",
            alt: "",
            align: "center",
            width: "100%",
            float: "none",
          },
        },
        {
          type: "audioBlock",
          attrs: {
            audioUploadId: "a-1",
            sourceUrl: "https://cdn/a.mp3",
            status: "READY",
          },
        },
      ],
    };
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(true);
  });

  it("rejects a mediaEmbed with mismatched provider/embedUrl (defense in depth)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "mediaEmbed",
          attrs: {
            provider: "twitter",
            sourceUrl: "https://twitter.com/x/status/1",
            embedUrl: "https://twitter.com/x/status/1",
            externalId: "1",
            renderMode: "iframe",
          },
        },
      ],
    };
    // `twitter` is not in the provider allowlist.
    expect(prosemirrorDocSchema.safeParse(doc).success).toBe(false);
  });
});
