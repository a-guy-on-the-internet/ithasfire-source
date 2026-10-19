import sanitizeHtml from "sanitize-html";
import { describe, expect, it, vi } from "vitest";

import {
  PAGE_RICH_TEXT_LINK_REL,
  PAGE_RICH_TEXT_MAX_HTML_LENGTH,
  PAGE_RICH_TEXT_MAX_INPUT_LENGTH,
  PAGE_RICH_TEXT_MAX_INPUT_TAGS,
  isRichTextEmpty,
  parsePageRichText,
  plainTextToParagraphs,
  sanitizePageRichText,
  toRichTextHtml,
} from "../page-rich-text";

// sanitize-html, passed through but counted: the cap tests prove a refused
// value is never parsed (a structural check, not a wall-clock one).
vi.mock("sanitize-html", async (importOriginal) => {
  // sanitize-html is `export =`: at runtime the function is `default`.
  const actual = await importOriginal<{
    default: typeof import("sanitize-html");
  }>();
  return {
    ...actual,
    default: Object.assign(vi.fn(actual.default), actual.default),
  };
});

// Allowlist check on the OUTPUT string. Every `<` must open one of the
// exact tag forms this sanitiser serialises, and no other `<` or `>` may
// remain: text is always escaped, so a browser's tokenizer can only see
// these elements (HTML namespace, no raw-text element, no other attribute,
// href only http/https/mailto). parse5 would be the stricter tool, but no
// workspace package declares it (it is only hoisted into the root
// node_modules), so this test does not depend on it.
const ALLOWED_TAG_FORMS =
  /<(?:p|strong|em|ul|ol|li)>|<\/(?:p|strong|em|ul|ol|li|a)>|<br \/>|<a href="(?:https?|mailto):[^"<>\s]*" rel="noopener noreferrer nofollow"(?: target="_blank")?>/g;

function assertAllowlisted(output: string): void {
  const rest = output.replace(ALLOWED_TAG_FORMS, "");
  expect(
    rest,
    `non-allowlisted markup in ${JSON.stringify(output)}`,
  ).not.toMatch(/[<>]/);
}

// The old name, kept for the table below.
const assertInert = assertAllowlisted;

// Small seeded PRNG (mulberry32) so the fuzz cases are the same every run.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_TOKENS = [
  "<p>",
  "</p>",
  "<b>",
  "</b>",
  "<i>",
  "</i>",
  "<em>",
  "</em>",
  "<strong>",
  "</strong>",
  "<ul>",
  "</ul>",
  "<ol>",
  "</ol>",
  "<li>",
  "</li>",
  "<br>",
  '<a href="https://x.example/">',
  '<a href="javascript:alert(1)">',
  '<a href="mailto:a@b.example" target="_blank">',
  "<a>",
  "</a>",
  "<xmp>",
  "</xmp>",
  "<XMP>",
  "<script>",
  "</script>",
  "<style>",
  "</style>",
  "<textarea>",
  "</textarea>",
  "<noscript>",
  "</noscript>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "</svg>",
  "<math><mtext><table><mglyph><style>",
  "<iframe>",
  "</iframe>",
  "<div>",
  "</div>",
  "<span>",
  "</span>",
  "<table>",
  "<td>",
  "<th>",
  "</th>",
  "<!--",
  "-->",
  "&lt;",
  "&gt;",
  "&amp;",
  "&#106;avascript:",
  "<",
  ">",
  "x",
  "Fish ",
  " chips",
  "\n",
  "\u202e",
  "\u200b",
  '"',
  "'",
  "`",
  '<a href="https://x.example/',
  '" onmouseover="x',
];

function fuzzCases(count: number, seed: number): string[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(random() * 14);
    let value = "";
    for (let k = 0; k < length; k++) {
      value += FUZZ_TOKENS[Math.floor(random() * FUZZ_TOKENS.length)];
    }
    return value;
  });
}

describe("sanitizePageRichText: hostile payloads", () => {
  const payloads: Array<[name: string, input: string, expected: string]> = [
    ["script tag", "<script>alert(1)</script>", ""],
    [
      "script inside a paragraph",
      "<p><script>alert(1)</script>hi</p>",
      "<p>hi</p>",
    ],
    ["img onerror", "<img src=x onerror=alert(1)>", ""],
    ["javascript: link", '<a href="javascript:alert(1)">x</a>', "x"],
    ["mixed-case javascript: link", '<a href="JaVaScRiPt:alert(1)">x</a>', "x"],
    [
      "entity-encoded javascript: link",
      '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
      "x",
    ],
    [
      "hex-entity javascript: link",
      '<a href="&#x6A;avascript:alert(1)">x</a>',
      "x",
    ],
    [
      "newline-split javascript: link",
      '<a href="java\nscript:alert(1)">x</a>',
      "x",
    ],
    [
      "tab-split javascript: link",
      '<a href="java&#9;script:alert(1)">x</a>',
      "x",
    ],
    [
      "leading-space javascript: link",
      '<a href="  javascript:alert(1)">x</a>',
      "x",
    ],
    [
      "data: link",
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      "x",
    ],
    ["vbscript: link", '<a href="vbscript:msgbox(1)">x</a>', "x"],
    ["protocol-relative link", '<a href="//evil.example/x">x</a>', "x"],
    ["relative link", '<a href="/admin">x</a>', "x"],
    [
      "tel: link (not on this allowlist)",
      '<a href="tel:+15551234567">x</a>',
      "x",
    ],
    ["link with no href", "<a>x</a>", "x"],
    ["svg onload", "<svg onload=alert(1)><circle/></svg>ok", "ok"],
    ["iframe", '<iframe src="https://evil.example"></iframe>ok', "ok"],
    ["style element", "<style>body{display:none}</style>ok", "ok"],
    [
      "style attribute",
      '<p style="color:red;background:url(javascript:x)">hi</p>',
      "<p>hi</p>",
    ],
    ["class attribute", '<p class="x">hi</p>', "<p>hi</p>"],
    [
      "onclick on an allowed tag",
      '<strong onclick="alert(1)">b</strong>',
      "<strong>b</strong>",
    ],
    [
      "form with input",
      '<form action="https://evil.example"><input name="pw"></form>ok',
      "ok",
    ],
    ["comment", "<p>a<!-- <script>alert(1)</script> -->b</p>", "<p>ab</p>"],
    [
      "textarea content",
      "<textarea><script>alert(1)</script></textarea>ok",
      "ok",
    ],
    [
      "math/mglyph mutation",
      "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
      "",
    ],
    ["object", '<object data="javascript:alert(1)"></object>ok', "ok"],
    [
      "meta refresh",
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">ok',
      "ok",
    ],
    ["base href", '<base href="javascript:alert(1)//">ok', "ok"],
    ["heading tag (not allowed, text kept)", "<h1>Title</h1>", "Title"],
    // sanitize-html 2.17.3 emits a disallowed <xmp>'s raw text unescaped in
    // discard mode; the shared base options drop it (BASE_SANITIZE_HTML_OPTIONS).
    ["xmp", "<xmp><img src=x onerror=alert(1)></xmp>", ""],
    [
      "xmp nested three deep",
      "<xmp><xmp><xmp><script>alert(1)</script></xmp></xmp></xmp>ok",
      "ok",
    ],
    ["xmp upper case", "<XMP><img src=x onerror=alert(1)></XMP>", ""],
    // HTML ignores the `/` on a non-void element: this still opens xmp.
    ["xmp self-closing", "<xmp/><img src=x onerror=alert(1)>", ""],
    [
      "xmp inside a paragraph",
      "<p><xmp><img src=x onerror=alert(1)></xmp>after</p>",
      "<p>after</p>",
    ],
    ["noscript", "<noscript><img src=x onerror=alert(1)></noscript>ok", "ok"],
    [
      "unclosed bad link among implied end tags (no marker leaks)",
      "<ol><a><b><a><ul><</b><ol>\n<strong>",
      "<ol><strong><ul>&lt;</ul></strong><ol>\n<strong></strong></ol></ol>",
    ],
  ];

  it.each(payloads)("%s", (_name, input, expected) => {
    const output = sanitizePageRichText(input);
    assertInert(output);
    expect(output).toBe(expected);
    expect(output).not.toContain("th-unwrap");
  });

  it("is idempotent on every hostile payload", () => {
    for (const [, input] of payloads) {
      const once = sanitizePageRichText(input);
      expect(sanitizePageRichText(once), input).toBe(once);
    }
  });

  // Explicit timeout: ~2 s alone, slower on a loaded machine.
  it(
    "seeded fuzz: output is allowlisted, marker-free and a fixpoint",
    {
      timeout: 60_000,
    },
    () => {
      for (const input of fuzzCases(4_000, 20261008)) {
        const once = sanitizePageRichText(input);
        assertAllowlisted(once);
        expect(once, input).not.toContain("th-unwrap");
        expect(sanitizePageRichText(once), input).toBe(once);
        const rich = toRichTextHtml(input);
        assertAllowlisted(rich);
        expect(toRichTextHtml(rich), input).toBe(rich);
      }
    },
  );

  it("keeps an entity-encoded tag as inert visible text", () => {
    const output = sanitizePageRichText(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(output).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    assertInert(output);
  });

  it("strips bidi overrides and zero-width characters from text", () => {
    expect(sanitizePageRichText("<p>a‮b​c﻿d</p>")).toBe("<p>abcd</p>");
  });

  it("caps nesting depth (deep tags lose their markup, keep their text)", () => {
    const deep = "<ul><li>".repeat(30) + "deep" + "</li></ul>".repeat(30);
    const output = sanitizePageRichText(deep);
    expect(output).toContain("deep");
    expect((output.match(/<ul>/g) ?? []).length).toBeLessThan(30);
  });
});

describe("sanitizePageRichText: allowed content", () => {
  it("keeps the allowed tags intact", () => {
    const input =
      "<p>Hello <strong>bold</strong> and <em>italic</em><br />next</p>" +
      "<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>";
    expect(sanitizePageRichText(input)).toBe(input);
  });

  it("maps b to strong and i to em, dropping their attributes", () => {
    expect(
      sanitizePageRichText('<b class="x">bold</b> <i onclick="y">it</i>'),
    ).toBe("<strong>bold</strong> <em>it</em>");
  });

  it("keeps http, https and mailto links with the fixed rel", () => {
    for (const href of [
      "https://example.com/a?b=1&c=2",
      "http://example.com/",
      "mailto:booking@example.com",
    ]) {
      const output = sanitizePageRichText(
        `<a href="${href.replace(/&/g, "&amp;")}">l</a>`,
      );
      expect(output).toContain(`rel="${PAGE_RICH_TEXT_LINK_REL}"`);
      expect(output).toMatch(/^<a href="(https?|mailto):/);
    }
  });

  it("keeps target=_blank, drops any other target, replaces input rel", () => {
    expect(
      sanitizePageRichText(
        '<a href="https://example.com/" target="_blank" rel="opener">l</a>',
      ),
    ).toBe(
      `<a href="https://example.com/" rel="${PAGE_RICH_TEXT_LINK_REL}" target="_blank">l</a>`,
    );
    expect(
      sanitizePageRichText(
        '<a href="https://example.com/" target="_top">l</a>',
      ),
    ).toBe(
      `<a href="https://example.com/" rel="${PAGE_RICH_TEXT_LINK_REL}">l</a>`,
    );
  });

  it("is idempotent", () => {
    const inputs = [
      '<p>a <a href="https://x.example/?q=1&amp;r=2" target="_blank">x</a> &amp; b</p>',
      "<ul><li><p>nested</p></li></ul>",
      "plain & <text>",
      "<p>café   \"quoted\" 'single'</p>",
    ];
    for (const input of inputs) {
      const once = sanitizePageRichText(input);
      expect(sanitizePageRichText(once)).toBe(once);
    }
  });
});

describe("plainTextToParagraphs", () => {
  it("splits on blank lines and turns single newlines into <br />", () => {
    expect(plainTextToParagraphs("First line\nsecond line\n\nNew para")).toBe(
      "<p>First line<br />second line</p><p>New para</p>",
    );
  });

  it("escapes markup so plain text stays text", () => {
    const output = plainTextToParagraphs(
      'Rock < Roll & <script>alert("x")</script>',
    );
    expect(output).toBe(
      '<p>Rock &lt; Roll &amp; &lt;script&gt;alert("x")&lt;/script&gt;</p>',
    );
    assertInert(output);
  });

  it("treats whitespace-only lines as paragraph breaks and drops empty paragraphs", () => {
    expect(plainTextToParagraphs("\n\na\n   \n\n\nb\n\n")).toBe(
      "<p>a</p><p>b</p>",
    );
    expect(plainTextToParagraphs("   \n\n  ")).toBe("");
  });

  it("normalises CRLF", () => {
    expect(plainTextToParagraphs("a\r\nb\r\n\r\nc")).toBe(
      "<p>a<br />b</p><p>c</p>",
    );
  });
});

describe("toRichTextHtml (FR-022)", () => {
  it("converts legacy plain text to paragraphs", () => {
    expect(toRichTextHtml("We host shows.\n\nAll ages.")).toBe(
      "<p>We host shows.</p><p>All ages.</p>",
    );
  });

  it("re-sanitises HTML", () => {
    expect(toRichTextHtml("<p>ok<img src=x onerror=alert(1)></p>")).toBe(
      "<p>ok</p>",
    );
  });

  it("returns empty for null, undefined and blank", () => {
    expect(toRichTextHtml(null)).toBe("");
    expect(toRichTextHtml(undefined)).toBe("");
    expect(toRichTextHtml("  \n ")).toBe("");
  });

  it("treats a literal '<' followed by a space or digit as plain text", () => {
    expect(toRichTextHtml("a < b, I <3 this")).toBe(
      "<p>a &lt; b, I &lt;3 this</p>",
    );
  });

  it("is idempotent across both branches", () => {
    for (const value of ["a\nb\n\nc", "<p>x</p>", "x & y"]) {
      const once = toRichTextHtml(value);
      expect(toRichTextHtml(once)).toBe(once);
    }
  });

  it("wraps sanitised output that lost every tag, so it is stable across reads", () => {
    const stored = toRichTextHtml(
      '<a href="javascript:alert(1)">Fish &amp; chips</a>',
    );
    expect(stored).toBe("<p>Fish &amp; chips</p>");
    let value = stored;
    for (let read = 0; read < 5; read++) value = toRichTextHtml(value);
    expect(value).toBe(stored);
    const parsed = parsePageRichText(
      '<a href="javascript:alert(1)">Fish &amp; chips</a>',
    );
    expect(parsed).toEqual({ ok: true, html: "<p>Fish &amp; chips</p>" });
  });

  it("treats only allowlisted tags as HTML; other tag-like text stays visible", () => {
    expect(toRichTextHtml("<scrip>t")).toBe("<p>&lt;scrip&gt;t</p>");
    expect(toRichTextHtml("<span>Fish &amp; chips</span>")).toBe(
      "<p>&lt;span&gt;Fish &amp;amp; chips&lt;/span&gt;</p>",
    );
    expect(toRichTextHtml("<B>bold</B> text")).toBe(
      "<strong>bold</strong> text",
    );
  });
});

describe("isRichTextEmpty", () => {
  it("sees Tiptap's empty document and whitespace as empty", () => {
    for (const html of [
      "",
      "<p></p>",
      "<p> </p>",
      "<p>&nbsp;</p>",
      "<p><br /></p>",
      null,
      undefined,
    ]) {
      expect(isRichTextEmpty(html)).toBe(true);
    }
  });

  it("sees text as non-empty", () => {
    expect(isRichTextEmpty("<p><strong>x</strong></p>")).toBe(false);
  });
});

describe("parsePageRichText (length cap)", () => {
  it("accepts and sanitises a normal value", () => {
    expect(parsePageRichText("<p>hi<script>x</script></p>")).toEqual({
      ok: true,
      html: "<p>hi</p>",
    });
  });

  it("refuses sanitised output over the cap", () => {
    const html = `<p>${"a".repeat(PAGE_RICH_TEXT_MAX_HTML_LENGTH)}</p>`;
    expect(parsePageRichText(html)).toEqual({
      ok: false,
      code: "rich_text_too_long",
      max: PAGE_RICH_TEXT_MAX_HTML_LENGTH,
    });
  });

  it("refuses raw input over the input cap before sanitising", () => {
    const raw = "<i></i>".repeat(
      Math.ceil(PAGE_RICH_TEXT_MAX_INPUT_LENGTH / 7) + 1,
    );
    const sanitizeCalls = vi.mocked(sanitizeHtml);
    sanitizeCalls.mockClear();
    const result = parsePageRichText(raw);
    expect(result.ok).toBe(false);
    expect(sanitizeCalls).not.toHaveBeenCalled();
  });

  // Explicit timeout: the at-cap parse is the costly case (deep nesting).
  it(
    "refuses more than PAGE_RICH_TEXT_MAX_INPUT_TAGS tags before parsing",
    {
      timeout: 30_000,
    },
    () => {
      const atCap = "<em>".repeat(PAGE_RICH_TEXT_MAX_INPUT_TAGS);
      const overCap = "<em>".repeat(PAGE_RICH_TEXT_MAX_INPUT_TAGS + 1);
      const sanitizeCalls = vi.mocked(sanitizeHtml);
      sanitizeCalls.mockClear();
      expect(parsePageRichText(overCap)).toMatchObject({
        ok: false,
        code: "rich_text_too_long",
      });
      // Refused by counting, without parsing.
      expect(sanitizeCalls).not.toHaveBeenCalled();
      // At the cap the value is parsed and accepted. Its cost (deep nesting;
      // ~2.8 s at 65_536 tags before the cap) is bounded loosely, so a loaded
      // machine does not flake it.
      const acceptedStart = performance.now();
      expect(parsePageRichText(atCap).ok).toBe(true);
      expect(sanitizeCalls).toHaveBeenCalled();
      expect(performance.now() - acceptedStart).toBeLessThan(10_000);
    },
  );

  it("never refuses a converted legacy value within the old 10_000 limit", () => {
    // Worst cases for growth: every character an ampersand, or ampersands
    // alternating with single newlines.
    for (const legacy of ["&".repeat(10_000), "&\n".repeat(5_000)]) {
      const result = parsePageRichText(legacy);
      expect(result.ok).toBe(true);
    }
  });
});
