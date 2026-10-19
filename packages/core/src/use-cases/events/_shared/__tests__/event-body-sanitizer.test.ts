import { describe, expect, it } from "vitest";

import {
  extractPlainText,
  sanitizeEventBody,
  validateEventBody,
} from "../event-body-sanitizer";

// Mirrors the fixtures in __tests__/save-event-media-embed-validation.test.ts
// — the sanitizer was extracted from save-event-shared's content superRefine
// and must accept/reject exactly the same bodies.

const validYouTubeNode = {
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
};

function baseContent(blocks: unknown[]) {
  return {
    version: 1,
    sections: [
      {
        id: "sec-1",
        kind: "section",
        style: {
          background: "default",
          density: "normal",
          maxWidth: "prose",
          textAlign: "left",
        },
        layout: {
          type: "singleColumn",
          columns: [{ blocks }],
        },
      },
    ],
  };
}

function richTextBlock(doc: unknown) {
  return { type: "richText", id: "blk-1", doc };
}

describe("validateEventBody / sanitizeEventBody", () => {
  it("accepts a valid body with an allowlisted embed", () => {
    const body = baseContent([
      richTextBlock({ type: "doc", content: [validYouTubeNode] }),
    ]);

    const result = validateEventBody(body);
    expect(result.ok).toBe(true);
    expect(sanitizeEventBody(body)).toBeDefined();
  });

  it("rejects an embed whose sourceUrl is outside the provider allowlist", () => {
    const evilNode = {
      type: "mediaEmbed",
      attrs: {
        provider: "youtube",
        sourceUrl: "https://evil.com/watch?v=dQw4w9WgXcQ",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        externalId: "dQw4w9WgXcQ",
        renderMode: "iframe",
      },
    };
    const body = baseContent([
      richTextBlock({ type: "doc", content: [evilNode] }),
    ]);

    const result = validateEventBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]!.message).toContain(
        "not from an allowed provider",
      );
    }

    expect(() => sanitizeEventBody(body)).toThrowError();
    try {
      sanitizeEventBody(body);
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects an embed whose attrs do not match the canonical parse", () => {
    const tamperedNode = {
      type: "mediaEmbed",
      attrs: {
        provider: "youtube",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        // Tampered: claims YouTube but the embedUrl carries a different id.
        embedUrl: "https://www.youtube-nocookie.com/embed/aaaaaaaaaaa",
        externalId: "dQw4w9WgXcQ",
        renderMode: "iframe",
      },
    };
    const body = baseContent([
      richTextBlock({ type: "doc", content: [tamperedNode] }),
    ]);

    const result = validateEventBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]!.message).toContain(
        "do not match canonical parse",
      );
    }
  });

  it("rejects an invalid body shape with invalid_input issues", () => {
    const body = { version: 99, bogus: true };

    const result = validateEventBody(body);
    expect(result.ok).toBe(false);

    try {
      sanitizeEventBody(body);
      throw new Error("expected sanitizeEventBody to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
      expect(
        (error as { issues: unknown[] }).issues.length,
      ).toBeGreaterThan(0);
    }
  });

  // cta href allowlist: absolute http(s) only — the public renderer
  // interpolates href raw into <a href="...">, so a javascript: (or
  // relative) href must never survive sanitization.
  it("rejects a cta block with a javascript: href", () => {
    const body = baseContent([
      {
        type: "cta",
        id: "blk-cta",
        label: "Click me",
        href: "javascript:alert(document.cookie)",
      },
    ]);

    const result = validateEventBody(body);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]!.message).toContain(
        "must be an absolute http(s) URL",
      );
    }

    try {
      sanitizeEventBody(body);
      throw new Error("expected sanitizeEventBody to throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_input" });
    }
  });

  it("rejects an http(s) cta href carrying attribute-breaking characters (belt-and-braces)", () => {
    for (const href of [
      'https://example.com/" onmouseover="alert(1)',
      "https://example.com/'x",
      "https://example.com/<script>",
      "https://example.com/a>b",
    ]) {
      const body = baseContent([
        { type: "cta", id: "blk-cta", label: "Click me", href },
      ]);
      expect(validateEventBody(body).ok).toBe(false);
    }
  });

  it("rejects a cta block with a relative href (v1 decision)", () => {
    const body = baseContent([
      { type: "cta", id: "blk-cta", label: "Tickets", href: "/tickets" },
    ]);

    expect(validateEventBody(body).ok).toBe(false);
  });

  it("accepts a cta block with an https:// href", () => {
    const body = baseContent([
      {
        type: "cta",
        id: "blk-cta",
        label: "Tickets",
        href: "https://example.com/tickets",
      },
    ]);

    expect(validateEventBody(body).ok).toBe(true);
  });
});

describe("extractPlainText", () => {
  it("walks v1 sections collecting rich text, cta labels, and image alt", () => {
    const body = baseContent([
      richTextBlock({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Open mic" },
              { type: "text", text: "every Tuesday" },
            ],
          },
        ],
      }),
      { type: "cta", id: "blk-2", label: "Sign up", href: "https://x.test" },
      {
        type: "image",
        id: "blk-3",
        asset: { assetId: "img-1" },
        alt: "Crowd photo",
      },
    ]);

    const text = extractPlainText(
      body as Parameters<typeof extractPlainText>[0],
    );
    expect(text).toContain("Open mic");
    expect(text).toContain("every Tuesday");
    expect(text).toContain("Sign up");
    expect(text).toContain("Crowd photo");
    // cta hrefs are included for cheap URL content checking.
    expect(text).toContain("https://x.test");
  });

  it("includes mediaEmbed titles (display-facing free text — filter bypass otherwise)", () => {
    const titledEmbed = {
      ...validYouTubeNode,
      attrs: { ...validYouTubeNode.attrs, title: "abusive embed title here" },
    };
    const body = baseContent([
      richTextBlock({ type: "doc", content: [titledEmbed] }),
    ]);

    // Sanity: the titled embed still passes sanitization (title is not part
    // of the canonical-parse round-trip) — extractPlainText is the ONLY line
    // of defense that routes it to ContentFilterPort.
    expect(validateEventBody(body).ok).toBe(true);

    const text = extractPlainText(
      body as Parameters<typeof extractPlainText>[0],
    );
    expect(text).toContain("abusive embed title here");
  });

  it("includes imageBlock captions (shown under the image — filter bypass otherwise)", () => {
    const body = baseContent([
      richTextBlock({
        type: "doc",
        content: [
          {
            type: "imageBlock",
            attrs: { imageId: "img-1", alt: "", caption: "abusive caption here" },
          },
        ],
      }),
    ]);

    expect(validateEventBody(body).ok).toBe(true);
    const text = extractPlainText(
      body as Parameters<typeof extractPlainText>[0],
    );
    expect(text).toContain("abusive caption here");
  });

  it("walks legacy blocks[] bodies", () => {
    const body = {
      layoutId: "default",
      blocks: [
        richTextBlock({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Legacy body text" }],
            },
          ],
        }),
      ],
    };

    const text = extractPlainText(
      body as Parameters<typeof extractPlainText>[0],
    );
    expect(text).toBe("Legacy body text");
  });

  it("returns an empty string for null/empty bodies", () => {
    expect(extractPlainText(null)).toBe("");
    expect(extractPlainText(undefined)).toBe("");
    expect(
      extractPlainText(
        baseContent([]) as Parameters<typeof extractPlainText>[0],
      ),
    ).toBe("");
  });
});
