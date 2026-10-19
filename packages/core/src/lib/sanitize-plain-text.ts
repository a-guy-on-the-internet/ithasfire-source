import { z } from "zod";
import { decode } from "entities";
import sanitizeHtml from "sanitize-html";

import { BASE_NON_TEXT_TAGS } from "./announcement-html";

/**
 * Normalize a short free-text field (title, address line, region, locality,
 * label, …) into safe, display-ready plain text.
 *
 * Short free-text fields are stored raw and rendered in many surfaces (cards,
 * meta tags, emails, mobile). They are NOT prose bodies — the prose body has
 * its own structural sanitizer (`event-body-sanitizer.ts`). Without this,
 * QA found two classes of problems:
 *
 *  1. Raw HTML — e.g. `<img src=x onerror=alert(1)>` or `<script>…</script>` —
 *     stored verbatim and interpolated into templates one careless renderer
 *     away from stored XSS.
 *  2. Unicode control / format chars — bidi overrides (U+202E RTL override),
 *     zero-width joiners, etc. — used for text spoofing and invisible-payload
 *     tricks.
 *
 * Pipeline (order matters):
 *  1. Strip ALL HTML tags with the `sanitize-html` library (allowlist of
 *     nothing → every tag discarded) and decode the entities it re-encodes,
 *     REPEATED TO A FIXPOINT. This is the security-sensitive step and MUST use
 *     a real HTML parser, never a regex.
 *
 *     Why a loop instead of a single strip+decode pass: sanitize-html re-
 *     encodes stray entities in its text output (a literal `<` becomes
 *     `&lt;`), and we decode them back so the stored value is true plain text
 *     (`"Rock < Roll"` stays `"Rock < Roll"`). But a single decode also turns
 *     an ENTITY-ENCODED payload such as `&lt;script&gt;…&lt;/script&gt;` —
 *     which sanitize-html correctly passed through as inert text — back into
 *     live `<script>…</script>` markup in the STORED value. Re-running
 *     strip+decode until the value stops changing collapses that reconstructed
 *     markup: the next strip pass discards the now-live tag. Double/triple-
 *     encoded payloads (`&amp;lt;script&amp;gt;`) converge the same way. A
 *     benign literal like `"Rock < Roll"` reaches a stable fixpoint on the
 *     first pass and is kept. Bounded to a small iteration cap as a guard
 *     against pathological non-convergence.
 *  2. Strip Unicode control (`\p{Cc}`) and format (`\p{Cf}`) characters. This
 *     covers C0/C1 controls, the bidi overrides (U+202A–U+202E, U+2066–U+2069)
 *     and the zero-width family (U+200B–U+200D, U+FEFF). A Unicode-property
 *     regex is the appropriate tool here — this is normalization, not HTML.
 *  3. Collapse internal whitespace runs to a single space and trim the ends.
 *
 * Emoji, accents, and all ordinary text pass through untouched.
 */
export function sanitizePlainText(input: string): string {
  // 1. Strip every HTML tag + decode entities, iterated to a fixpoint so an
  //    entity-encoded payload can't reconstruct live markup in the output
  //    (see the doc comment above).
  const stripped = stripTagsToFixpoint(input);

  // 2. Remove Unicode control + format chars (bidi overrides, zero-width, …).
  //    Whitespace controls (newline, tab, CR, form/vertical feed) become a
  //    SPACE rather than being deleted, so a value pasted across lines
  //    ("Summer\nFest") collapses to "Summer Fest", not "SummerFest".
  const withoutControls = stripped.replace(/[\p{Cc}\p{Cf}]/gu, (ch) =>
    /[\t\n\r\f\v]/.test(ch) ? " " : "",
  );

  // 3. Collapse internal whitespace runs to a single space and trim.
  return withoutControls.replace(/\s+/g, " ").trim();
}

/**
 * Strip every HTML tag + decode entities, iterated to a fixpoint so an
 * entity-encoded payload can't reconstruct live markup in the output (see the
 * {@link sanitizePlainText} doc comment for the full rationale). Shared by the
 * single-line and multi-line sanitizers. The cap bounds any non-convergence.
 */
function stripTagsToFixpoint(input: string): string {
  const strip = (value: string) =>
    sanitizeHtml(value, {
      allowedTags: [],
      allowedAttributes: {},
      disallowedTagsMode: "discard",
      // Drop the content of script/style/textarea/option/xmp too: a disallowed
      // `<xmp>`'s text otherwise comes out raw and unescaped.
      nonTextTags: [...BASE_NON_TEXT_TAGS],
    });

  let cur = input;
  let converged = false;
  for (let i = 0; i < 5; i++) {
    const next = decode(strip(cur));
    if (next === cur) {
      converged = true;
      break;
    }
    cur = next;
  }

  // If a pathologically multi-encoded payload didn't converge within the cap,
  // the last value may still hold reconstructed `<…>` markup. Do ONE final
  // strip WITHOUT a trailing decode so no tag can survive. We only do this on
  // non-convergence: a converged value is already plain text, and re-stripping
  // it would re-encode a legitimate literal `<` (e.g. "Rock < Roll").
  return converged ? cur : strip(cur);
}

/**
 * Multi-line variant of {@link sanitizePlainText} for free-text fields that
 * legitimately span multiple lines (descriptions, notes, statements, bios).
 * IDENTICAL security posture — the same tag-strip + entity-decode fixpoint and
 * the same bidi/zero-width/control stripping — but it PRESERVES paragraph
 * structure instead of flattening everything to one line:
 *
 *  1. Strip HTML tags + decode entities to a fixpoint (shared helper).
 *  2. Remove Unicode control (`\p{Cc}`) + format (`\p{Cf}`) chars EXCEPT the
 *     newline (U+000A) and tab (U+0009). Bidi overrides (U+202E, …) and the
 *     zero-width family (U+200B, U+FEFF, …) are still stripped.
 *  3. Collapse runs of horizontal whitespace (spaces/tabs) to a single space,
 *     collapse 3+ consecutive newlines to at most two (a double newline),
 *     leaving single and double newlines intact, and trim the ends.
 */
export function sanitizePlainTextMultiline(input: string): string {
  // 1. Strip every HTML tag + decode entities, iterated to a fixpoint.
  const stripped = stripTagsToFixpoint(input);

  // 2. Remove Unicode control + format chars, but keep newline and tab so
  //    paragraph/line structure survives. Everything else in Cc/Cf (bidi
  //    overrides, zero-width joiners, C0/C1 controls, U+FEFF, …) is stripped.
  const withoutControls = stripped.replace(/[\p{Cc}\p{Cf}]/gu, (ch) =>
    ch === "\n" || ch === "\t" ? ch : "",
  );

  // 3. Collapse horizontal whitespace runs (spaces + tabs) to a single space,
  //    collapse 3+ consecutive newlines to at most two, then trim the ends.
  return withoutControls
    .replace(/[^\S\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * Zod helper for a REQUIRED short free-text field: sanitize BEFORE length
 * validation so the `min(1)`/`max` bounds apply to the CLEANED value. A title
 * made entirely of HTML tags or control characters collapses to `""` and
 * correctly fails `min(1)`.
 *
 * Chain the existing `.nullable()`/`.optional()`/`.default()` wrappers AFTER
 * the returned schema (they short-circuit before the transform, so null/
 * undefined pass through untouched).
 */
export const plainTextRequired = (max: number) =>
  z
    .string()
    .transform(sanitizePlainText)
    .pipe(z.string().min(1).max(max));

/**
 * Zod helper for an OPTIONAL/nullable short free-text field: same sanitize-
 * before-validate ordering as {@link plainTextRequired}, but without the
 * `min(1)` floor (an empty cleaned value is allowed). Chain
 * `.nullable()`/`.optional()`/`.default()` AFTER as needed.
 */
export const plainTextOptional = (max: number) =>
  z
    .string()
    .transform(sanitizePlainText)
    .pipe(z.string().max(max));

/**
 * Zod helper for a REQUIRED multi-line free-text field (description, note,
 * statement, bio): sanitize with {@link sanitizePlainTextMultiline} BEFORE
 * length validation so the `min(1)`/`max` bounds apply to the CLEANED value,
 * while newlines survive. Chain `.nullable()`/`.optional()`/`.default()` AFTER.
 */
export const plainTextMultilineRequired = (max: number) =>
  z
    .string()
    .transform(sanitizePlainTextMultiline)
    .pipe(z.string().min(1).max(max));

/**
 * Zod helper for an OPTIONAL/nullable multi-line free-text field: same
 * sanitize-before-validate ordering as {@link plainTextMultilineRequired} but
 * without the `min(1)` floor. Chain `.nullable()`/`.optional()`/`.default()`
 * AFTER as needed.
 */
export const plainTextMultilineOptional = (max: number) =>
  z
    .string()
    .transform(sanitizePlainTextMultiline)
    .pipe(z.string().max(max));
