import libEscapeHtml from "escape-html";

/**
 * Escaping helpers for the few code paths that build HTML strings by hand
 * (e.g. `eventBodyToHtml`).  Any user-authored value interpolated into such
 * a string must pass through these — event bodies can be proposed by anyone,
 * so treat every field as hostile regardless of backend sanitization.
 */

/**
 * Escape `&`, `<`, `>`, `"` and `'` for safe interpolation into HTML text
 * content or double/single-quoted attribute values.  Delegates to the
 * maintained `escape-html` package (the one Express uses), which escapes
 * exactly those five characters and leaves UTF-8/emoji intact.
 */
export function escapeHtml(value: string): string {
  return libEscapeHtml(value);
}

const ALLOWED_HREF_SCHEMES = /^(?:https?:|mailto:|tel:)/i;

/**
 * Allow only `http:`, `https:`, `mailto:`, `tel:` and same-origin relative
 * hrefs; everything else (`javascript:`, `data:`, protocol-relative
 * `//host` — including the `/\host` backslash form the URL parser
 * normalizes to `//host`, unknown schemes) becomes `"#"`.  Browsers strip
 * tab/CR/LF and leading/trailing control characters before parsing URLs, so
 * the checks run against a control-stripped copy to defeat obfuscations like
 * `"java\tscript:"` or `"/\t/evil.com"`.
 */
export function safeHref(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point (see comment above)
  const stripped = value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (stripped.startsWith("/")) {
    // 47 = "/", 92 = backslash — the URL parser maps backslash to "/" in the
    // authority position for http(s), so "/\host" is protocol-relative too.
    const second = stripped.charCodeAt(1);
    return second === 47 || second === 92 ? "#" : value.trim();
  }
  return ALLOWED_HREF_SCHEMES.test(stripped) ? value.trim() : "#";
}
