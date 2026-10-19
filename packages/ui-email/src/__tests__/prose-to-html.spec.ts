import { describe, expect, it } from "vitest";

import { proseMirrorDocToEmailHtml } from "../lib/prose-to-html";

// Organiser-written docs (waitlist confirmation body, announcements) are
// stored as unvalidated JSON, so every attr that reaches the HTML must be
// escaped or clamped.
describe("proseMirrorDocToEmailHtml attr hardening", () => {
  it("clamps a non-numeric heading level instead of interpolating it", () => {
    const html = proseMirrorDocToEmailHtml({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: '1><a href="https://evil.example">x</a><h1' },
          content: [{ type: "text", text: "Hi" }],
        },
      ],
    });
    expect(html).not.toContain("evil.example");
    expect(html).toMatch(/^<h2 style=/);
    expect(html).toContain(">Hi</h2>");
  });

  it("renders a clean h1-h3 for an attribute-smuggling level", () => {
    const html = proseMirrorDocToEmailHtml({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: "1 onclick=x><a href=//evil>" },
          content: [{ type: "text", text: "Hi" }],
        },
      ],
    });
    expect(html).not.toMatch(/onclick|evil|<a\b/);
    expect(html).toMatch(/^<h[123] style="[^"]*">Hi<\/h[123]>$/);
  });

  it("keeps real heading levels 1-3", () => {
    for (const level of [1, 2, 3]) {
      const html = proseMirrorDocToEmailHtml({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level },
            content: [{ type: "text", text: "T" }],
          },
        ],
      });
      expect(html.startsWith(`<h${level} `)).toBe(true);
    }
  });

  it("escapes text content", () => {
    const html = proseMirrorDocToEmailHtml({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "<img src=x onerror=1>" }],
        },
      ],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
