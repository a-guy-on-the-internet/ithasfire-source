/**
 * Server-side sanitizer for announcement email body HTML.
 *
 * The admin client renders prose content via TipTap and submits both the
 * canonical ProseMirror doc (`bodyDoc`) and a generated HTML string
 * (`bodyHtml`). The HTML is what we put on the wire to recipients, so we
 * must not trust an authenticated organizer's claim about its contents — a
 * malicious or buggy client could otherwise smuggle scripts, tracking
 * pixels, or phishing links through.
 *
 * The allowlist below mirrors the tag/attr surface that TipTap emits for
 * the configured prose-editor extensions (StarterKit + Highlight + image,
 * audio, and media-embed blocks). Anything outside that surface is
 * stripped silently.
 */

import sanitizeHtmlLib from "sanitize-html";

/**
 * Disallowed tags whose CONTENT is dropped along with the tag, for every
 * sanitize-html call in discard mode. sanitize-html's default is
 * script/style/textarea/option; `xmp` is added because sanitize-html 2.17.3
 * emits a disallowed `<xmp>`'s raw text UNESCAPED in discard mode, so
 * `<xmp><img src=x onerror=alert(1)></xmp>` came out as a live `<img>`.
 * Passing `nonTextTags` replaces the default list, so the defaults are
 * restated here.
 */
export const BASE_NON_TEXT_TAGS: readonly string[] = Object.freeze([
  "script",
  "style",
  "textarea",
  "option",
  "xmp",
]);

/**
 * Options every allowlist HTML sanitiser in core shares (this one and the
 * page editor's rich text, `page-rich-text.ts`):
 *
 * - `allowProtocolRelative: false`: `//evil.example` is treated as a URL
 *   with a scheme and must pass the scheme allowlist, which it cannot.
 * - `disallowedTagsMode: "discard"`: a tag outside the allowlist is dropped
 *   but its inner text survives (except the {@link BASE_NON_TEXT_TAGS},
 *   whose content is dropped too).
 */
export const BASE_SANITIZE_HTML_OPTIONS = {
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  nonTextTags: BASE_NON_TEXT_TAGS as string[],
} as const satisfies sanitizeHtmlLib.IOptions;

const ALLOWED_PROTOCOLS = ["http", "https", "mailto", "tel"] as const;

const ALLOWED_TAGS = [
  // Block / structure
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "blockquote",
  "ul",
  "ol",
  "li",
  "div",
  "span",
  "figure",
  "figcaption",
  // Inline marks
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "mark",
  // Links
  "a",
  // Embedded media (images render in email; audio / iframes generally do
  // not — they fall back to alt text or a link, which is desirable).
  "img",
  "audio",
  "source",
];

const allowedAttributes: Record<string, string[]> = {
  a: ["href", "target", "rel", "title"],
  img: ["src", "alt", "title", "width", "height"],
  audio: ["src", "controls", "preload"],
  source: ["src", "type"],
  // Provider/source metadata for media-embed figures (used by the
  // useHydrateMediaEmbeds client to upgrade these into iframes).
  figure: [
    "data-type",
    "data-provider",
    "data-source-url",
    "data-embed-url",
    "data-external-id",
    "data-render-mode",
    "data-kind",
    "data-title",
    "data-aspect-ratio",
    "style",
  ],
  // ImageBlock and AudioBlock emit data-* attrs identifying their assets.
  div: [
    "class",
    "data-type",
    "data-image-id",
    "data-audio-upload-id",
    "data-source-url",
    "data-hls-playlist-url",
    "data-status",
    "data-waveform-peaks",
    "style",
  ],
  span: ["class", "style"],
  p: ["style"],
  h1: ["style"],
  h2: ["style"],
  h3: ["style"],
  h4: ["style"],
  h5: ["style"],
  h6: ["style"],
  blockquote: ["style"],
  ul: ["style"],
  ol: ["style"],
  li: ["style"],
  mark: ["style"],
};

/**
 * Sanitize organizer-supplied announcement body HTML against a strict allowlist.
 *
 * - Strips `<script>`, event handlers (`onclick=`, `onerror=`…), and any
 *   tag outside the allowlist.
 * - Allows only `http(s):`, `mailto:`, and `tel:` URLs in `href`/`src`.
 * - Drops `style` attribute values that contain `expression(`, `url(javascript:…)`,
 *   or other CSS-injection vectors via sanitize-html's default style filter.
 *
 * Returns the sanitized HTML string. The output is safe to render in an
 * email client; `<script>`, `<iframe>`, and other dangerous tags will not
 * survive.
 */
export function sanitizeAnnouncementHtml(input: string): string {
  return sanitizeHtmlLib(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes,
    // Whitelist a small set of safe CSS properties on `style`. Anything
    // referencing `url(...)`, `expression(...)`, JS protocols, or `@import`
    // is dropped because the regex allowlist does not match.
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i, /^rgba\(/i, /^[a-z-]+$/i],
        "background-color": [
          /^#[0-9a-f]{3,8}$/i,
          /^rgb\(/i,
          /^rgba\(/i,
          /^[a-z-]+$/i,
        ],
        "text-align": [/^left$|^right$|^center$|^justify$/i],
        "font-weight": [/^\d{3}$|^bold$|^normal$/i],
        "font-style": [/^italic$|^normal$/i],
        "text-decoration": [/^none$|^underline$|^line-through$/i],
        margin: [/^[\d. -]+(px|em|rem|%)?$/i],
        "margin-top": [/^[\d. -]+(px|em|rem|%)?$/i],
        "margin-bottom": [/^[\d. -]+(px|em|rem|%)?$/i],
        padding: [/^[\d. -]+(px|em|rem|%)?$/i],
        border: [
          /^[\d. -]+(px|em|rem|%)? +(solid|dashed|dotted) +#[0-9a-f]{3,8}$/i,
        ],
        "border-radius": [/^[\d. -]+(px|em|rem|%)?$/i],
      },
    },
    allowedSchemes: [...ALLOWED_PROTOCOLS],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    // Protocol-relative URLs refused; a disallowed tag's inner text survives
    // but nothing else (see BASE_SANITIZE_HTML_OPTIONS).
    ...BASE_SANITIZE_HTML_OPTIONS,
    // Convert legacy `<b>`/`<i>` to `<strong>`/`<em>` for consistency? No —
    // both are in the allowlist; leave them as-is.
    transformTags: {
      // Force `target=_blank` links to carry safe rel values.
      a: (tagName, attribs) => {
        const next: Record<string, string> = { ...attribs };
        if (attribs.target === "_blank") {
          const existingRel = (attribs.rel ?? "").split(/\s+/).filter(Boolean);
          for (const required of ["noopener", "noreferrer"]) {
            if (!existingRel.includes(required)) existingRel.push(required);
          }
          next.rel = existingRel.join(" ");
        }
        return { tagName, attribs: next };
      },
    },
  });
}
