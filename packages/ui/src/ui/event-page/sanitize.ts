// NOTE: This lives in the UI package so rendering doesn't depend on a missing
// services package. Keep it conservative and dependency-free.

// This is NOT a full HTML sanitizer.
// It is intended only for rendering already-sanitized server HTML, with a
// defensive pass to strip obviously-dangerous constructs in previews.
//
// `EventPageRenderer` (the sole `dangerouslySetInnerHTML` consumer of this
// function) is currently dead code — exported, never imported anywhere in
// the repo — so this is not exploitable today. It's hardened anyway so it
// isn't a landmine if that component gets wired up later: `packages/ui`
// deliberately does not import from `packages/core` (no existing
// precedent for that cross-layer dependency), so we can't reach for the
// real `sanitize-html`-backed sanitizers there and instead harden this
// regex-based approach directly.

// Tags whose opening tag AND everything up to (and including) the matching
// closing tag must be discarded outright — not just the tag itself, since
// their content can carry executable payloads (e.g. inline <script>/<style>
// text, an <iframe srcdoc="...">'s attribute, raw SVG with <script>/event
// handlers).
const BLOCKED_TAG_BLOCKS = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "svg",
] as const;

/** One pass of the strip rules. Mutation-XSS-style payloads (e.g. a blocked
 * tag nested inside another blocked tag) can reconstruct a live tag after a
 * single pass, so `sanitizeAndNormalizeRichTextHtml` reruns this to a
 * fixpoint rather than applying it once. */
function stripOnce(html: string): string {
  let out = html;

  // Strip dangerous tags (opening tag through matching closing tag, so any
  // attributes or inner markup/text go with them). Falls back to stripping
  // just the opening tag (up to the next ">") if no matching closing tag is
  // found, so an unterminated/self-closing tag can't survive either.
  for (const tag of BLOCKED_TAG_BLOCKS) {
    const pairedRe = new RegExp(
      `<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`,
      "gi",
    );
    out = out.replace(pairedRe, "");
    const openOnlyRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    out = out.replace(openOnlyRe, "");
  }

  // Strip inline event handlers like onclick="...", onclick='...', AND the
  // unquoted form (e.g. `onerror=alert(1)` inside `<img src=x onerror=alert(1)>`)
  // — the original quoted-only regexes let unquoted handler values survive.
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");

  // Remove javascript: URLs.
  out = out.replace(/(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, '$1=""');
  out = out.replace(/(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "$1=''");
  out = out.replace(
    /(href|src)\s*=\s*javascript:[^\s>]*/gi,
    '$1=""',
  );

  return out;
}

const FIXPOINT_ITERATION_CAP = 5;

export function sanitizeAndNormalizeRichTextHtml(html: string): string {
  if (!html) return "";

  let out = html;
  for (let i = 0; i < FIXPOINT_ITERATION_CAP; i++) {
    const next = stripOnce(out);
    if (next === out) break;
    out = next;
  }

  return out;
}
