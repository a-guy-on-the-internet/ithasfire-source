/**
 * Rich text for entity page blocks (About, later Mission): the page editor's
 * XSS boundary (spec docs/specs/2026-10-08/entity-page-wysiwyg-editor.spec.yaml
 * R4, FR-003, FR-022).
 *
 * The editor (Tiptap) sends HTML. The server never trusts it: every value is
 * run through `sanitizePageRichText` before it reaches the draft, so the
 * draft, and everything Publish writes from it, only ever holds HTML this
 * module produced. The public renderer must still render only the output of
 * this module (or `toRichTextHtml` for legacy values).
 *
 * ALLOWLIST (everything else is removed):
 *   p, br, strong, em, ul, ol, li   no attributes at all
 *   a                               href (absolute http, https or mailto only),
 *                                   rel (always exactly "noopener noreferrer
 *                                   nofollow", set here, never taken from
 *                                   input), target (only "_blank", kept when
 *                                   the input asked for it)
 *   b → strong, i → em              mapped, so the stored form is canonical
 *
 * A link whose href is missing, relative, protocol-relative or uses any other
 * scheme (javascript:, data:, vbscript:, tel:, …) is UNWRAPPED: its text
 * stays, the `<a>` goes. The href check runs on the attribute value after the
 * HTML parser has decoded entities (`&#106;avascript:`) and parsed with the
 * WHATWG URL parser, which strips the tab/newline tricks (`java\nscript:`)
 * the same way a browser does; sanitize-html's own scheme check
 * (`allowedSchemes`) runs again on the result as a second layer.
 *
 * Text nodes lose Unicode control (Cc, except tab and newline) and format
 * (Cf) characters: bidi overrides, zero-width joiners, U+FEFF. Same rule as
 * `sanitizePlainTextMultiline` (sanitize-plain-text.ts) applies to plain
 * text, so the spoofing class it closes stays closed in rich text.
 *
 * Built on the shared core sanitize-html options
 * (`BASE_SANITIZE_HTML_OPTIONS` in announcement-html.ts): protocol-relative
 * URLs refused, disallowed tags discarded with their text kept, except the
 * raw-text tags in `BASE_NON_TEXT_TAGS`, whose content is dropped too.
 * `xmp` MUST be in that list: in discard mode sanitize-html 2.17.3 passes a
 * disallowed `<xmp>`'s raw text through UNESCAPED, so
 * `<xmp><img src=x onerror=alert(1)></xmp>` would come out as a live
 * `<img>`. The self-closing `<xmp/>` is the same hole (HTML ignores the `/`
 * on a non-void element, so it still opens a raw-text element). Never
 * override `nonTextTags` here without keeping xmp. Comments are always
 * dropped by sanitize-html.
 */

import escapeHtml from "escape-html";
import sanitizeHtmlLib from "sanitize-html";

import { BASE_SANITIZE_HTML_OPTIONS } from "./announcement-html";
import { sanitizePlainTextMultiline } from "./sanitize-plain-text";

/**
 * Longest stored rich-text value, in UTF-16 code units of the SANITISED HTML.
 *
 * Why 65_536: the legacy plain-text About/Mission limit is 10_000 characters
 * (`plainTextMultilineOptional(10_000)` in block-config.ts). Converting plain
 * text to paragraph HTML (FR-022) grows it by at most ~5.5x in the worst case
 * (`&` → `&amp;` is 5x; alternating `&` and newline is 11 characters of HTML
 * per 2 of text). 65_536 covers that, so a converted legacy value can never be
 * a value the draft then refuses, while a few rich-text fields still keep a
 * draft far below any request body limit.
 */
export const PAGE_RICH_TEXT_MAX_HTML_LENGTH = 65_536;

/**
 * Raw input refused before sanitising when longer than this: it bounds the
 * parser's work on a hostile payload. Sanitising usually shrinks input
 * (Tiptap emits attributes this module strips), hence the headroom.
 */
export const PAGE_RICH_TEXT_MAX_INPUT_LENGTH =
  PAGE_RICH_TEXT_MAX_HTML_LENGTH * 4;

/**
 * Most `<` characters a raw input may hold (counted before parsing).
 * sanitize-html's work grows with the square of nesting depth: 65_536
 * nested `<em>` take seconds. Real About text has a few hundred tags.
 */
export const PAGE_RICH_TEXT_MAX_INPUT_TAGS = 16_384;

/** Refusal code for a rich-text value over a length or tag cap. */
export const PAGE_RICH_TEXT_TOO_LONG = "rich_text_too_long" as const;

const ALLOWED_TAGS = ["p", "br", "strong", "em", "a", "ul", "ol", "li"];

const ALLOWED_LINK_PROTOCOLS = ["http:", "https:", "mailto:"] as const;

/** Exactly the rel every stored link carries. */
export const PAGE_RICH_TEXT_LINK_REL = "noopener noreferrer nofollow";

/**
 * Deepest element nesting kept. Real content (a list inside a list inside a
 * paragraph) is a few levels; deeper tags are discarded with their text kept,
 * so a hostile payload cannot hand the renderer a pathological tree.
 */
const NESTING_LIMIT = 12;

/**
 * A tag name nothing allowlists: transforming to it unwraps the element.
 * sanitize-html can emit a stray `</th-unwrap>` end tag when end tags are
 * implied (an unclosed bad link among unclosed tags); the second pass in
 * sanitizePageRichText discards it, so it never reaches stored HTML.
 */
const UNWRAP_TAG = "th-unwrap";

const CONTROL_OR_FORMAT_EXCEPT_TAB_NEWLINE = /[\p{Cc}\p{Cf}]/gu;

function stripControlChars(text: string): string {
  return text.replace(CONTROL_OR_FORMAT_EXCEPT_TAB_NEWLINE, (ch) =>
    ch === "\n" || ch === "\t" ? ch : "",
  );
}

/** The absolute http(s)/mailto URL a link may carry, or null. */
function safeLinkHref(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let parsed: URL;
  try {
    // No base URL: a relative href ("/x", "x", "//host/x") throws here.
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (
    !(ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(parsed.protocol)
  ) {
    return null;
  }
  return parsed.href;
}

const PAGE_RICH_TEXT_OPTIONS: sanitizeHtmlLib.IOptions = {
  ...BASE_SANITIZE_HTML_OPTIONS,
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: { a: ["href", "rel", "target"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {},
  allowedSchemesAppliedToAttributes: ["href"],
  allowedStyles: {},
  allowedClasses: {},
  nestingLimit: NESTING_LIMIT,
  // Escaped text in, escaped text out: removing characters cannot create
  // markup.
  textFilter: (text) => stripControlChars(text),
  transformTags: {
    b: "strong",
    i: "em",
    a: (_tagName, attribs) => {
      const href = safeLinkHref(attribs.href);
      if (href === null) {
        return { tagName: UNWRAP_TAG, attribs: {} };
      }
      const next: Record<string, string> = {
        href,
        rel: PAGE_RICH_TEXT_LINK_REL,
      };
      // Consistent with sanitizeAnnouncementHtml: a new-tab link always
      // carries noopener noreferrer (here every link does). Any other target
      // value is dropped, so a link can never aim at a named frame.
      if (attribs.target === "_blank") next.target = "_blank";
      return { tagName: "a", attribs: next };
    },
  },
};

/**
 * Sanitise editor HTML against the page rich-text allowlist (see the module
 * comment). Idempotent: sanitising its own output returns it unchanged.
 * Does NOT apply the length cap; use `parsePageRichText` at a write
 * boundary.
 */
export function sanitizePageRichText(html: string): string {
  // Two passes. One pass is not a fixpoint: implied end tags can leave
  // structure (or a stray UNWRAP_TAG end tag) that a second parse reads
  // differently. The second pass reaches a fixpoint (seeded fuzz in the
  // tests), which is what makes the stored form canonical.
  return sanitizeHtmlLib(
    sanitizeHtmlLib(html, PAGE_RICH_TEXT_OPTIONS),
    PAGE_RICH_TEXT_OPTIONS,
  );
}

/**
 * Plain text → paragraph HTML (FR-022). Control characters are stripped as
 * in `sanitizePlainTextMultiline`, the text is HTML-escaped, blank lines
 * (a newline, optional whitespace, a newline) split paragraphs, and a single
 * newline inside a paragraph becomes `<br />`. Empty or whitespace-only text
 * returns "". The result is passed through `sanitizePageRichText` so its form
 * is canonical (identical to what a round trip through the editor stores).
 */
export function plainTextToParagraphs(text: string): string {
  const normalized = stripControlChars(text.replace(/\r\n?/g, "\n"));
  const paragraphs = normalized
    .split(/\n[^\S\n]*\n/)
    .map((paragraph) => paragraph.replace(/^\s+|\s+$/g, ""))
    .filter((paragraph) => paragraph.length > 0)
    .map(
      (paragraph) =>
        `<p>${paragraph
          .split("\n")
          .map((line) => escapeHtml(line))
          .join("<br />")}</p>`,
    );
  return sanitizePageRichText(paragraphs.join(""));
}

/**
 * A stored value is treated as HTML only when it contains a tag from this
 * module's input vocabulary (`<p>`, `</p>`, `<br>`, `<b>`, `<a href…>`, …).
 * Anything else is plain text, so a literal `<` (`a < b`, `<3`) or a
 * tag-like word (`<scrip>t`) is kept as visible text instead of being
 * parsed away. Editor output always has at least a `<p>`.
 *
 * The vocabulary is derived from the options (the allowlist plus the tags
 * `transformTags` maps), so allowing a new tag is a one-line change there.
 */
const INPUT_TAG_NAMES = [
  ...new Set([
    ...ALLOWED_TAGS,
    ...Object.keys(PAGE_RICH_TEXT_OPTIONS.transformTags ?? {}).filter(
      (name) => name !== "*",
    ),
  ]),
];
const ALLOWLISTED_TAG = new RegExp(
  `<\\/?(?:${INPUT_TAG_NAMES.join("|")})(?=[\\s/>])[^>]*>`,
  "i",
);

function looksLikeHtml(value: string): boolean {
  return ALLOWLISTED_TAG.test(value);
}

/** Sanitised output with no tag at all (every tag removed) gets a paragraph. */
const ANY_TAG = /<\/?[a-z]/i;

/**
 * Any stored About/Mission value → sanitised rich-text HTML (FR-022): legacy
 * plain text becomes paragraphs; HTML is re-sanitised. null, undefined and
 * whitespace-only values return "". Idempotent.
 */
export function toRichTextHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (value.trim() === "") return "";
  if (!looksLikeHtml(value)) return plainTextToParagraphs(value);
  const html = sanitizePageRichText(value);
  if (html.trim() === "") return "";
  // `<a href="javascript:x">Fish &amp; chips</a>` sanitises to tagless text
  // (the bad link is unwrapped); stored as is,
  // the next read would take the plain-text branch and escape it again
  // (`&amp;amp;`). Wrapping it keeps toRichTextHtml idempotent.
  return ANY_TAG.test(html) ? html : `<p>${html}</p>`;
}

/**
 * True when the HTML has no visible text: "", "<p></p>" (Tiptap's empty
 * document), whitespace, `&nbsp;`, a bare `<br />`. Publish uses it so an
 * empty section is not created (FR-011).
 */
export function isRichTextEmpty(html: string | null | undefined): boolean {
  if (html === null || html === undefined) return true;
  return sanitizePlainTextMultiline(html) === "";
}

export type PageRichTextParseResult =
  | { ok: true; html: string }
  | { ok: false; code: typeof PAGE_RICH_TEXT_TOO_LONG; max: number };

/**
 * The write boundary: accept legacy plain text or editor HTML, return the
 * sanitised HTML, or refuse with `rich_text_too_long` when the raw input is
 * over `PAGE_RICH_TEXT_MAX_INPUT_LENGTH` or holds more than
 * `PAGE_RICH_TEXT_MAX_INPUT_TAGS` `<` characters (both checked BEFORE
 * parsing), or the sanitised result is over `PAGE_RICH_TEXT_MAX_HTML_LENGTH`.
 */
export function parsePageRichText(value: string): PageRichTextParseResult {
  if (
    value.length > PAGE_RICH_TEXT_MAX_INPUT_LENGTH ||
    countTagOpeners(value) > PAGE_RICH_TEXT_MAX_INPUT_TAGS
  ) {
    return {
      ok: false,
      code: PAGE_RICH_TEXT_TOO_LONG,
      max: PAGE_RICH_TEXT_MAX_HTML_LENGTH,
    };
  }
  const html = toRichTextHtml(value);
  if (html.length > PAGE_RICH_TEXT_MAX_HTML_LENGTH) {
    return {
      ok: false,
      code: PAGE_RICH_TEXT_TOO_LONG,
      max: PAGE_RICH_TEXT_MAX_HTML_LENGTH,
    };
  }
  return { ok: true, html };
}

function countTagOpeners(value: string): number {
  let count = 0;
  for (
    let index = value.indexOf("<");
    index !== -1;
    index = value.indexOf("<", index + 1)
  ) {
    count++;
  }
  return count;
}
