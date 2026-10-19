import { describe, expect, it } from "vitest";

import { escapeHtml, safeHref } from "../escape-html";

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

describe("escapeHtml", () => {
  it("escapes double-quote attribute breakouts", () => {
    expect(escapeHtml('x" onmouseover="alert(1)')).toBe(
      "x&quot; onmouseover=&quot;alert(1)",
    );
  });

  it("escapes single quotes and angle brackets (element injection)", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes ampersands first so its own entities are never double-escaped", () => {
    expect(escapeHtml("Fish & Chips")).toBe("Fish &amp; Chips");
    expect(escapeHtml("a < b & c")).toBe("a &lt; b &amp; c");
    expect(escapeHtml("a < b & c")).not.toContain("&amp;lt;");
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("&")).not.toBe("&amp;amp;");
  });
});

describe("safeHref", () => {
  it("preserves http(s), mailto, tel and relative hrefs", () => {
    expect(safeHref("https://example.com/tickets?a=1&b=2")).toBe(
      "https://example.com/tickets?a=1&b=2",
    );
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(safeHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeHref("tel:+15551234567")).toBe("tel:+15551234567");
    expect(safeHref("/events/foo-bar")).toBe("/events/foo-bar");
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("rejects javascript: including case and whitespace obfuscations", () => {
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("JAVASCRIPT:alert(1)")).toBe("#");
    expect(safeHref("  JaVaScRiPt:alert(1)")).toBe("#");
    expect(safeHref("java" + TAB + "script:alert(1)")).toBe("#");
    expect(safeHref(LF + "javascript:alert(1)")).toBe("#");
  });

  it("rejects data:, vbscript:, unknown schemes and empty values", () => {
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(safeHref("vbscript:msgbox(1)")).toBe("#");
    expect(safeHref("foo:bar")).toBe("#");
    expect(safeHref("")).toBe("#");
    expect(safeHref("   ")).toBe("#");
  });

  it("rejects protocol-relative hrefs, including control-char obfuscation", () => {
    expect(safeHref("//evil.example.com")).toBe("#");
    expect(safeHref("/" + TAB + "/evil.example.com")).toBe("#");
  });

  it("rejects the backslash protocol-relative form the URL parser maps to //", () => {
    expect(safeHref("/" + BACKSLASH + "evil.example.com")).toBe("#");
    expect(safeHref("/" + TAB + BACKSLASH + "evil.example.com")).toBe("#");
    // A backslash later in the path is same-origin and stays allowed.
    expect(safeHref("/events/foo" + BACKSLASH + "bar")).toBe(
      "/events/foo" + BACKSLASH + "bar",
    );
  });
});
