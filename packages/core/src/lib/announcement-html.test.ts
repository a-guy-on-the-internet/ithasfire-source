import { describe, expect, it } from "vitest";

import { sanitizeAnnouncementHtml } from "./announcement-html";

describe("sanitizeAnnouncementHtml", () => {
  it("preserves benign prose markup emitted by TipTap", () => {
    const input =
      "<h2>Title</h2><p>Hello <strong>there</strong>, <em>friend</em>.</p>" +
      "<ul><li>One</li><li>Two</li></ul>" +
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">link</a></p>';
    const out = sanitizeAnnouncementHtml(input);
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>there</strong>");
    expect(out).toContain("<em>friend</em>");
    expect(out).toContain("<li>One</li>");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain("nofollow");
  });

  it("strips <script> tags", () => {
    const out = sanitizeAnnouncementHtml(
      "<p>Hi</p><script>alert(1)</script><p>End</p>",
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>Hi</p>");
    expect(out).toContain("<p>End</p>");
  });

  it("strips event-handler attributes", () => {
    const out = sanitizeAnnouncementHtml(
      '<p onclick="alert(1)" onerror="alert(2)">x</p>',
    );
    expect(out).not.toMatch(/onclick|onerror/i);
    expect(out).toContain("<p>x</p>");
  });

  it("rejects javascript: hrefs", () => {
    const out = sanitizeAnnouncementHtml(
      '<a href="javascript:alert(1)">tap</a>',
    );
    expect(out).not.toContain("javascript:");
  });

  it("strips iframes (would be CSP-violating in webmail anyway)", () => {
    const out = sanitizeAnnouncementHtml(
      '<iframe src="https://evil.example/x"></iframe><p>after</p>',
    );
    expect(out).not.toMatch(/<iframe/i);
    expect(out).toContain("<p>after</p>");
  });

  it("strips style values that try to escape via expression() or url()", () => {
    const out = sanitizeAnnouncementHtml(
      '<p style="background:url(javascript:alert(1))">x</p>',
    );
    expect(out).not.toContain("javascript");
  });

  it("forces noopener/noreferrer on target=_blank links missing them", () => {
    const out = sanitizeAnnouncementHtml(
      '<a href="https://example.com" target="_blank">tap</a>',
    );
    expect(out).toContain('target="_blank"');
    expect(out).toContain("noopener");
    expect(out).toContain("noreferrer");
  });

  it("keeps figure[data-type=media-embed] containers used by media embed renderer", () => {
    const out = sanitizeAnnouncementHtml(
      '<figure data-type="media-embed" data-provider="youtube" data-source-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ">' +
        '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ" target="_blank" rel="noopener noreferrer nofollow">YouTube embed</a>' +
        "</figure>",
    );
    expect(out).toContain("<figure");
    expect(out).toContain('data-type="media-embed"');
    expect(out).toContain('data-provider="youtube"');
  });

  it("keeps an image figure's <figcaption> text, escaped, and drops attrs on it", () => {
    const out = sanitizeAnnouncementHtml(
      '<figure data-type="image-block"><img src="https://cdn.example/a.jpg" alt="">' +
        '<figcaption onclick="alert(1)">Doors &amp; &lt;script&gt;</figcaption></figure>',
    );
    expect(out).toContain("<figcaption>Doors &amp; &lt;script&gt;</figcaption>");
    expect(out).not.toContain("onclick");
  });

  it("strips unknown tags but keeps their text content", () => {
    const out = sanitizeAnnouncementHtml(
      "<p>Before <custom-element>inner</custom-element> after</p>",
    );
    expect(out).toContain("Before");
    expect(out).toContain("inner");
    expect(out).toContain("after");
    expect(out).not.toContain("custom-element");
  });
});

// sanitize-html 2.17.3 emits a disallowed <xmp>'s raw text UNESCAPED in
// discard mode, so nested <xmp> payloads came out as live markup: one pass
// left `<xmp><img …>`, the second (the public page re-sanitises on read) left
// a bare `<img src=x onerror=…>`. BASE_NON_TEXT_TAGS drops <xmp> content.
describe("sanitizeAnnouncementHtml: <xmp> raw-text payloads", () => {
  const PAYLOADS: Array<[string, string]> = [
    ["single", "<xmp><img src=x onerror=alert(1)></xmp>"],
    ["nested twice", "<xmp><xmp><img src=x onerror=alert(1)></xmp>"],
    [
      "nested three deep",
      "<xmp><xmp><xmp><img src=x onerror=alert(1)></xmp></xmp></xmp>",
    ],
    ["upper case", "<XMP><IMG SRC=x ONERROR=alert(1)></XMP>"],
    // Self-closing: htmlparser2 leaves raw-text mode on `<xmp/>` but still
    // opens an xmp frame, so the decoded `&lt;img …&gt;` came out raw in ONE
    // pass before the fix.
    ["self-closing xmp", "<xmp/>&lt;img src=x onerror=alert(1)&gt;"],
    ["self-closing textarea", "<textarea/>&lt;img src=x onerror=alert(1)&gt;"],
    // Deeper than the plain-text fixpoint's 5-pass cap: before the fix one
    // <xmp> layer peeled per pass, so this left `<xmp><xmp><img …>`.
    ["nested eight deep", "<xmp>".repeat(8) + "<img src=x onerror=alert(1)>"],
    ["inside <p>", "<p>Hi <xmp><img src=x onerror=alert(1)></xmp> there</p>"],
    [
      "nested inside <p>",
      "<p><xmp><xmp><xmp><img src=x onerror=alert(1)></xmp></xmp></p>",
    ],
  ];

  it.each(PAYLOADS)("%s: no live markup after 1, 2 and 3 passes", (_, input) => {
    const once = sanitizeAnnouncementHtml(input);
    const twice = sanitizeAnnouncementHtml(once);
    const thrice = sanitizeAnnouncementHtml(twice);
    for (const out of [once, twice, thrice]) {
      expect(out.toLowerCase()).not.toContain("<img");
      expect(out.toLowerCase()).not.toContain("onerror");
      expect(out.toLowerCase()).not.toContain("<xmp");
    }
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it("keeps the prose around a dropped <xmp>", () => {
    const out = sanitizeAnnouncementHtml(
      "<p>Hi <xmp><img src=x onerror=alert(1)></xmp> there</p>",
    );
    expect(out).toContain("Hi");
    expect(out).toContain("there");
  });
});
