import { describe, expect, it } from "vitest";

import { sanitizeAndNormalizeRichTextHtml } from "../sanitize";

describe("sanitizeAndNormalizeRichTextHtml", () => {
  it("returns an empty string for falsy input", () => {
    expect(sanitizeAndNormalizeRichTextHtml("")).toBe("");
  });

  it("strips script tags and their contents", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      "<p>hi</p><script>alert(1)</script>",
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips quoted inline event handlers", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      `<img src="x" onerror="alert(1)">`,
    );
    expect(out).not.toMatch(/onerror/i);
  });

  it("strips UNQUOTED inline event handlers (previously survived)", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      `<img src=x onerror=alert(1)>`,
    );
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toContain("alert(1)");
  });

  it("strips svg blocks (previously unblocked)", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      `<svg onload="alert(1)"><script>alert(2)</script></svg><p>safe</p>`,
    );
    expect(out).not.toMatch(/<svg/i);
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("alert(2)");
    expect(out).toContain("<p>safe</p>");
  });

  it("strips iframe blocks including srcdoc payloads", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
    );
    expect(out).not.toMatch(/<iframe/i);
    expect(out).not.toContain("alert(1)");
  });

  it("strips style, object, and embed blocks", () => {
    const out = sanitizeAndNormalizeRichTextHtml(
      `<style>body{background:url(javascript:alert(1))}</style>` +
        `<object data="evil.swf"></object>` +
        `<embed src="evil.swf">`,
    );
    expect(out).not.toMatch(/<style/i);
    expect(out).not.toMatch(/<object/i);
    expect(out).not.toMatch(/<embed/i);
  });

  it("removes javascript: URLs in href/src, quoted and unquoted", () => {
    const quoted = sanitizeAndNormalizeRichTextHtml(
      `<a href="javascript:alert(1)">click</a>`,
    );
    expect(quoted).not.toMatch(/javascript:/i);

    const unquoted = sanitizeAndNormalizeRichTextHtml(
      `<a href=javascript:alert(1)>click</a>`,
    );
    expect(unquoted).not.toMatch(/javascript:/i);
  });

  it("leaves benign markup untouched", () => {
    const safe = "<p>Hello <strong>world</strong></p>";
    expect(sanitizeAndNormalizeRichTextHtml(safe)).toBe(safe);
  });
});
