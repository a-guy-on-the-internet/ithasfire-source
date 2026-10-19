import { describe, it, expect } from "vitest";
import type { ProseMirrorDoc } from "@th/schema";
import {
  proseMirrorDocToHtml,
  htmlToProseMirrorDoc,
  hasContent,
  createEmptyDoc,
} from "../prose-utils";

/**
 * Strip `xmlns="http://www.w3.org/1999/xhtml"` attributes injected by
 * `zeed-dom` (used by `@tiptap/html` in Node/test environments).  This
 * lets assertions compare clean HTML without coupling to the serialiser's
 * namespace behaviour.
 */
const stripNs = (html: string) =>
  html.replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, "");

describe("prose-utils", () => {
  describe("proseMirrorDocToHtml", () => {
    it("converts a simple paragraph to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello world" }],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toBe("<p>Hello world</p>");
    });

    it("converts bold text to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Bold text",
                marks: [{ type: "bold" }],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toBe("<p><strong>Bold text</strong></p>");
    });

    it("converts italic text to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Italic text",
                marks: [{ type: "italic" }],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toBe("<p><em>Italic text</em></p>");
    });

    it("converts links to HTML with security attributes", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Click here",
                marks: [
                  { type: "link", attrs: { href: "https://example.com" } },
                ],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain('href="https://example.com"');
      expect(stripNs(html)).toContain('rel="noopener noreferrer nofollow"');
      expect(stripNs(html)).toContain(">Click here</a>");
    });

    it("converts iframe media embeds to hydratable placeholders with canonical data attrs", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
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
        ],
      };

      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).toContain('data-type="media-embed"');
      expect(html).toContain('data-provider="youtube"');
      expect(html).toContain(
        'data-source-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"',
      );
      expect(html).toContain(
        'data-embed-url="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"',
      );
      expect(html).toContain('data-external-id="dQw4w9WgXcQ"');
      expect(html).toContain('data-render-mode="iframe"');
      expect(html).not.toContain("<iframe");
    });

    it("keeps Bandcamp media embeds in link render mode", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "mediaEmbed",
            attrs: {
              provider: "bandcamp",
              sourceUrl: "https://artist.bandcamp.com/track/example-track",
              embedUrl: "https://artist.bandcamp.com/track/example-track",
              externalId: "artist.bandcamp.com/track/example-track",
              renderMode: "link",
              kind: "track",
              aspectRatio: "1/1",
            },
          },
        ],
      };

      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).toContain('data-provider="bandcamp"');
      expect(html).toContain('data-render-mode="link"');
      expect(html).toContain(
        'href="https://artist.bandcamp.com/track/example-track"',
      );
      expect(html).not.toContain("<iframe");
    });

    it("converts headings to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Main Title" }],
          },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Subtitle" }],
          },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "Section" }],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<h1>Main Title</h1>");
      expect(stripNs(html)).toContain("<h2>Subtitle</h2>");
      expect(stripNs(html)).toContain("<h3>Section</h3>");
    });

    it("converts bullet lists to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "First item" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Second item" }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<ul>");
      expect(stripNs(html)).toContain("<li><p>First item</p></li>");
      expect(stripNs(html)).toContain("<li><p>Second item</p></li>");
      expect(stripNs(html)).toContain("</ul>");
    });

    it("converts ordered lists to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "orderedList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Step one" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Step two" }],
                  },
                ],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<ol>");
      expect(stripNs(html)).toContain("<li><p>Step one</p></li>");
      expect(stripNs(html)).toContain("<li><p>Step two</p></li>");
      expect(stripNs(html)).toContain("</ol>");
    });

    it("converts blockquotes to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "A wise quote" }],
              },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<blockquote>");
      expect(stripNs(html)).toContain("<p>A wise quote</p>");
      expect(stripNs(html)).toContain("</blockquote>");
    });

    it("converts horizontal rules to HTML", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Before" }],
          },
          { type: "horizontalRule" },
          {
            type: "paragraph",
            content: [{ type: "text", text: "After" }],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<p>Before</p>");
      expect(stripNs(html)).toMatch(/<hr\s*\/?>/);
      expect(stripNs(html)).toContain("<p>After</p>");
    });

    it("converts mixed content with formatting", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Event Description" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Join us for an " },
              {
                type: "text",
                text: "amazing",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: " evening of " },
              {
                type: "text",
                text: "live music",
                marks: [{ type: "italic" }],
              },
              { type: "text", text: "!" },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(stripNs(html)).toContain("<h1>Event Description</h1>");
      expect(stripNs(html)).toContain("<strong>amazing</strong>");
      expect(stripNs(html)).toContain("<em>live music</em>");
    });

    it("handles empty document", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(html).toBe("");
    });

    it("handles null/undefined content gracefully", () => {
      const html = proseMirrorDocToHtml({ type: "doc", content: [] });
      expect(html).toBe("");
    });

    it("resolves imageBlock src from imageUrlMap", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "imageBlock",
            attrs: {
              imageId: "img-1",
              alt: "photo",
              align: "center",
              width: "100%",
              float: "none",
            },
          } as any,
        ],
      };

      const html = proseMirrorDocToHtml(doc, {
        "img-1": "https://cdn.example.com/photo.jpg",
      });
      expect(html).toContain('src="https://cdn.example.com/photo.jpg"');
      expect(html).toContain('alt="photo"');
      expect(html).toContain('data-type="image-block"');
    });

    it("falls back gracefully when imageId is not in map", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "imageBlock",
            attrs: {
              imageId: "missing",
              alt: "gone",
              align: "center",
              width: "100%",
              float: "none",
            },
          } as any,
        ],
      };

      const html = proseMirrorDocToHtml(doc, {});
      // Should still produce an img tag, just with empty src
      expect(html).toContain("<img");
      expect(html).toContain('data-type="image-block"');
    });

    it("leaves imageBlock untouched when no imageUrlMap provided", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "imageBlock",
            attrs: {
              imageId: "img-1",
              alt: "",
              align: "center",
              width: "100%",
              float: "none",
            },
          } as any,
        ],
      };

      const html = proseMirrorDocToHtml(doc);
      expect(html).toContain('src=""');
    });
  });

  describe("htmlToProseMirrorDoc", () => {
    it("converts simple HTML to ProseMirror doc", () => {
      const html = "<p>Hello world</p>";
      const doc = htmlToProseMirrorDoc(html);

      expect(doc.type).toBe("doc");
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0].type).toBe("paragraph");
    });

    it("converts HTML with formatting", () => {
      const html = "<p><strong>Bold</strong> and <em>italic</em></p>";
      const doc = htmlToProseMirrorDoc(html);

      expect(doc.type).toBe("doc");
      expect(doc.content[0].type).toBe("paragraph");
      // Should have text nodes with marks
      const paragraph = doc.content[0] as any;
      expect(paragraph.content).toBeDefined();
      expect(paragraph.content.length).toBeGreaterThan(0);
    });

    it("converts headings from HTML", () => {
      const html = "<h1>Title</h1><h2>Subtitle</h2>";
      const doc = htmlToProseMirrorDoc(html);

      expect(doc.content[0].type).toBe("heading");
      expect((doc.content[0] as any).attrs.level).toBe(1);
      expect(doc.content[1].type).toBe("heading");
      expect((doc.content[1] as any).attrs.level).toBe(2);
    });

    it("converts lists from HTML", () => {
      const html = "<ul><li>Item 1</li><li>Item 2</li></ul>";
      const doc = htmlToProseMirrorDoc(html);

      expect(doc.content[0].type).toBe("bulletList");
    });
  });

  describe("hasContent", () => {
    it("returns false for null", () => {
      expect(hasContent(null)).toBe(false);
    });

    it("returns false for empty doc", () => {
      const doc: ProseMirrorDoc = { type: "doc", content: [] };
      expect(hasContent(doc)).toBe(false);
    });

    it("returns false for doc with only empty paragraph", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [{ type: "paragraph" }],
      };
      expect(hasContent(doc)).toBe(false);
    });

    it("returns false for doc with paragraph containing only whitespace", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "   " }],
          },
        ],
      };
      expect(hasContent(doc)).toBe(false);
    });

    it("returns true for doc with text content", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      };
      expect(hasContent(doc)).toBe(true);
    });

    // Media-only bodies are content: the builder's "Start from" row keys off
    // this, and a starter pick over an image-only body would replace it.
    it.each([
      ["imageBlock", { imageId: "img-1" }],
      ["audioBlock", { audioId: "aud-1" }],
      [
        "mediaEmbed",
        {
          provider: "youtube",
          sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        },
      ],
    ])("returns true for a doc holding only a %s", (type, attrs) => {
      const doc: ProseMirrorDoc = { type: "doc", content: [{ type, attrs }] };
      expect(hasContent(doc)).toBe(true);
    });

    it("returns true for doc with heading", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Title" }],
          },
        ],
      };
      expect(hasContent(doc)).toBe(true);
    });

    it("returns true for doc with list", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph" }],
              },
            ],
          },
        ],
      };
      expect(hasContent(doc)).toBe(true);
    });
  });

  describe("createEmptyDoc", () => {
    it("creates a valid empty document", () => {
      const doc = createEmptyDoc();

      expect(doc.type).toBe("doc");
      expect(doc.content).toHaveLength(1);
      expect(doc.content[0].type).toBe("paragraph");
    });
  });

  describe("adversarial input — generateHTML XSS round-trip", () => {
    it("escapes <script>-like text content as plain text", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "<script>alert(1)</script>" }],
          },
        ],
      };
      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).not.toContain("<script");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes HTML in attribute values", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "click",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href: 'https://example.com/"><img onerror=alert(1)>',
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
      const html = stripNs(proseMirrorDocToHtml(doc));
      // The angle-bracket-and-quote payload must not break out of the href
      // attribute and create a sibling tag.
      expect(html).not.toMatch(/<img[^>]*onerror/i);
      // Whatever survives must be inside an href="" value with quotes
      // properly escaped.
      expect(html).toMatch(/href="[^"]*"/);
    });

    it("rejects javascript: URLs in link marks (link extension allowlist)", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "tap",
                marks: [
                  { type: "link", attrs: { href: "javascript:alert(1)" } },
                ],
              },
            ],
          },
        ],
      };
      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).not.toContain("javascript:");
    });

    it("rejects data: URLs in link marks", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "tap",
                marks: [
                  {
                    type: "link",
                    attrs: { href: "data:text/html,<script>alert(1)</script>" },
                  },
                ],
              },
            ],
          },
        ],
      };
      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).not.toContain("data:text/html");
      expect(html).not.toContain("<script");
    });

    it("escapes adversarial text inside headings", () => {
      const doc: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: '"><img src=x onerror=alert(1)>' }],
          },
        ],
      };
      const html = stripNs(proseMirrorDocToHtml(doc));
      expect(html).not.toMatch(/<img[^>]*onerror/i);
      expect(html).toContain("&lt;img");
    });
  });

  describe("round-trip conversion", () => {
    it("preserves content through JSON -> HTML -> JSON conversion", () => {
      const original: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Welcome" }],
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "This is " },
              {
                type: "text",
                text: "important",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: " info." },
            ],
          },
        ],
      };

      const html = proseMirrorDocToHtml(original);
      const restored = htmlToProseMirrorDoc(html);

      // Structure should match
      expect(restored.type).toBe("doc");
      expect(restored.content).toHaveLength(2);
      expect(restored.content[0].type).toBe("heading");
      expect(restored.content[1].type).toBe("paragraph");
    });

    it("keeps an image caption through doc -> HTML -> doc -> HTML", () => {
      const original: ProseMirrorDoc = {
        type: "doc",
        content: [
          {
            type: "imageBlock",
            attrs: {
              imageId: "img-1",
              alt: "Stage",
              align: "left",
              width: "50%",
              float: "right",
              caption: "Doors at 7 & <b>not</b> before",
            },
          } as any,
        ],
      };

      for (const imageUrlMap of [
        { "img-1": "https://cdn.example.com/photo.jpg" },
        undefined,
      ]) {
        const html = proseMirrorDocToHtml(original, imageUrlMap);
        const restored = htmlToProseMirrorDoc(html);
        const attrs = (restored.content[0] as any).attrs;
        expect(attrs.caption).toBe("Doors at 7 & <b>not</b> before");
        expect(attrs.imageId).toBe("img-1");
        // Stable: a second pass renders the same HTML.
        expect(proseMirrorDocToHtml(restored, imageUrlMap)).toBe(html);
      }
    });

    it("reads a pasted figure's figcaption as one trimmed line, and none as null", () => {
      const doc = htmlToProseMirrorDoc(
        '<figure data-type="image-block" data-image-id="a"><img src="https://x.example/a.jpg" alt="">' +
          "<figcaption>\n  Two\n  lines  </figcaption></figure>" +
          '<figure data-type="image-block" data-image-id="b"><img src="https://x.example/b.jpg" alt=""></figure>',
      );
      const [first, second] = doc.content as any[];
      expect(first.attrs.caption).toBe("Two lines");
      expect(second.attrs.caption).toBeNull();
    });
  });
});
