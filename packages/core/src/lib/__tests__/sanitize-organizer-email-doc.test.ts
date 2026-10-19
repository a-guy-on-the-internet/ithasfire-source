import { describe, expect, it } from "vitest";

import { sanitizeOrganizerEmailDoc } from "../sanitize-organizer-email-doc";

describe("sanitizeOrganizerEmailDoc", () => {
  it("returns null for anything that isn't a doc with content", () => {
    expect(sanitizeOrganizerEmailDoc(null)).toBeNull();
    expect(sanitizeOrganizerEmailDoc("x")).toBeNull();
    expect(sanitizeOrganizerEmailDoc({ type: "paragraph" })).toBeNull();
    expect(sanitizeOrganizerEmailDoc({ type: "doc", content: [] })).toBeNull();
  });

  it("keeps plain formatting intact", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world", marks: [{ type: "italic" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "a" }] },
              ],
            },
          ],
        },
        { type: "horizontalRule" },
      ],
    };
    expect(sanitizeOrganizerEmailDoc(doc)).toEqual(doc);
  });

  it("drops link marks but keeps the words", () => {
    const out = sanitizeOrganizerEmailDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "go",
              marks: [{ type: "link", attrs: { href: "https://x.example" } }],
            },
          ],
        },
      ],
    });
    expect(out).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "go" }] }],
    });
  });

  it("drops stray attrs and clamps heading levels", () => {
    const out = sanitizeOrganizerEmailDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { style: "x" },
          content: [{ type: "text", text: "p" }],
        },
        {
          type: "heading",
          attrs: { level: 9 },
          content: [{ type: "text", text: "h" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "h3" }],
        },
      ],
    });
    expect(out?.content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "p" }],
    });
    expect(out?.content[1]?.attrs).toEqual({ level: 2 });
    expect(out?.content[2]?.attrs).toEqual({ level: 3 });
  });

  it("strips bidi/zero-width characters from text", () => {
    const out = sanitizeOrganizerEmailDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "pay‮gro.live​" }],
        },
      ],
    });
    expect(out?.content[0]?.content?.[0]?.text).toBe("paygro.live");
  });

  it("bounds total text length", () => {
    const out = sanitizeOrganizerEmailDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "a".repeat(50_000) }],
        },
      ],
    });
    expect(out?.content[0]?.content?.[0]?.text).toHaveLength(10_000);
  });

  it("unwraps unknown node types into paragraphs of their text", () => {
    const out = sanitizeOrganizerEmailDoc({
      type: "doc",
      content: [
        {
          type: "iframe",
          attrs: { src: "https://x.example" },
          content: [{ type: "text", text: "inner" }],
        },
        { type: "image", attrs: { src: "https://x.example/p.png" } },
      ],
    });
    expect(out).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "inner" }] },
      ],
    });
  });
});
