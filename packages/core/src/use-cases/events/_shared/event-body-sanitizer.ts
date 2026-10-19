import { eventBodySchema, type EventBody } from "@th/schema";

import { collectMediaEmbedNodes } from "../../../lib/embeds/walk-body-for-embeds";
import { parseEmbedUrl } from "../../../lib/embeds/parse-embed-url";

/**
 * Shared EventBody validation + media-embed re-verification.
 *
 * Extracted from `save-event-shared.ts`'s `baseSaveEventInputSchema.content`
 * superRefine so the owned builder save path AND the edit-suggestion
 * submit/apply paths (community-managed-event-listings FR-007: "Any body
 * write on ANY event goes through the same shared sanitizer") run the exact
 * same checks:
 *
 *  1. The body must parse against `eventBodySchema` (@th/schema).
 *  2. Defense-in-depth: every `mediaEmbed` node is re-verified by re-parsing
 *     its `sourceUrl` through the URL allowlist. The editor will already have
 *     done this, but the server is the source of truth — a malicious or
 *     out-of-date client could otherwise smuggle an arbitrary embedUrl into
 *     an iframe by claiming it matches a known provider.
 *  3. Every `cta` block's `href` must be an ABSOLUTE http:// or https:// URL.
 *     The schema leaves `href` unconstrained and the public renderer
 *     (event-body-to-html.ts) interpolates it raw into `<a href="...">`, so a
 *     `javascript:` href would be stored XSS one approval away. Relative URLs
 *     are rejected in v1: no builder surface creates cta blocks today
 *     (event-body-to-html.ts is the only consumer), so no existing body can
 *     carry one — rejecting is simplest and safest. This intentionally
 *     tightens the owned builder save path too; the error surfaces as the
 *     same `invalid_input` issue shape as the embed checks.
 */

export interface EventBodyIssue {
  path: (string | number)[];
  message: string;
}

export type ValidateEventBodyResult =
  | { ok: true; body: EventBody }
  | { ok: false; issues: EventBodyIssue[] };

/**
 * Validate an unknown value as EventBody, re-verify its media embeds against
 * the provider allowlist, and enforce the cta href protocol allowlist.
 * Pure — returns issues instead of throwing, so schema `superRefine` call
 * sites can forward them verbatim.
 */
export function validateEventBody(value: unknown): ValidateEventBodyResult {
  const parsed = eventBodySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path as (string | number)[],
        message: issue.message,
      })),
    };
  }

  const issues: EventBodyIssue[] = [];
  const embeds = collectMediaEmbedNodes(parsed.data);
  for (const embed of embeds) {
    const reparsed = parseEmbedUrl(embed.sourceUrl);
    if (!reparsed) {
      issues.push({
        path: ["mediaEmbed"],
        message: `media embed sourceUrl is not from an allowed provider: ${embed.sourceUrl}`,
      });
      continue;
    }
    if (
      reparsed.provider !== embed.provider ||
      reparsed.sourceUrl !== embed.sourceUrl ||
      reparsed.embedUrl !== embed.embedUrl ||
      reparsed.externalId !== embed.externalId ||
      reparsed.renderMode !== embed.renderMode
    ) {
      issues.push({
        path: ["mediaEmbed"],
        message: `media embed attrs do not match canonical parse for ${embed.sourceUrl}`,
      });
    }
  }

  // cta href allowlist (rule 3 in the module doc comment): absolute http(s)
  // only. `new URL(href)` without a base throws on relative URLs, which IS
  // the v1 rejection. Issue shape mirrors the embed issues.
  forEachBlock(parsed.data, (block) => {
    if (block.type !== "cta" || typeof block.href !== "string") return;
    if (!isAllowedCtaHref(block.href)) {
      issues.push({
        path: ["cta"],
        message: `cta href must be an absolute http(s) URL: ${block.href}`,
      });
    }
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, body: parsed.data };
}

function isAllowedCtaHref(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
  } catch {
    // Relative or unparseable — rejected in v1 (see module doc comment).
    return false;
  }
  // Belt-and-braces: the RAW stored href is what the public renderer
  // interpolates into `<a href="...">`, so reject any attribute-breaking
  // characters outright even when the protocol is http(s). This runs at the
  // validateEventBody choke point, covering submit, apply, AND create-listing
  // in one place.
  return !/["'<>]/.test(href);
}

/**
 * Throwing variant for imperative call sites (edit-suggestion submit/apply).
 * Throws the SAME `invalid_input` shape `parseInput` produces today for a
 * bad body on the owned builder save path, so transports map it identically.
 *
 * NOTE on the return value: this returns the zod-NORMALIZED body
 * (`parsed.data` — schema defaults applied), while the owned builder save
 * path intentionally keeps persisting the RAW input value (behavior-
 * preserving extraction; `baseSaveEventInputSchema.content` only validates
 * and passes the raw value through). The edit-suggestion apply path (Step 4)
 * should persist THIS returned normalized value.
 */
export function sanitizeEventBody(value: unknown): EventBody {
  const result = validateEventBody(value);
  if (!result.ok) {
    throw {
      code: "invalid_input",
      message: "invalid_input",
      issues: result.issues.map((issue) => ({
        code: "custom",
        path: issue.path,
        message: issue.message,
      })),
    } as const;
  }
  return result.body;
}

// ── Plain-text extraction (for ContentFilterPort) ────────────────────────────

/**
 * Walk an EventBody and concatenate all human-readable text so it can be run
 * through ContentFilterPort (FR-007 / NFR-001). Covers:
 *  - richText blocks: every ProseMirror `text` node AND every `mediaEmbed`
 *    node's `attrs.title` — the embed title is arbitrary free text (up to 512
 *    chars) that the canonical-parse round-trip deliberately does NOT verify
 *    and that the web renderer DISPLAYS (embed header label + iframe title),
 *    so skipping it would be a content-filter bypass — and every `imageBlock`
 *    node's `attrs.caption`, which the page shows under the image
 *  - cta blocks: the button label AND the href string (cheap URL content
 *    checking — a slur in a domain/path should trip the filter too)
 *  - image blocks: the alt text
 * Layout/style attrs are ignored (enums/ids, no free text). Embed URLs are
 * additionally validated by the allowlist above.
 *
 * Handles both body shapes (`sections[].layout.columns[].blocks[]` and the
 * legacy top-level `blocks[]`), mirroring `collectMediaEmbedNodes`.
 */
export function extractPlainText(body: EventBody | null | undefined): string {
  if (!body || typeof body !== "object") return "";

  const parts: string[] = [];
  forEachBlock(body, (block) => collectTextFromBlock(block, parts));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Invoke `visit` for every block in either body shape
 * (`sections[].layout.columns[].blocks[]` and legacy `blocks[]`).
 */
function forEachBlock(
  body: unknown,
  visit: (block: Record<string, unknown>) => void,
): void {
  if (!body || typeof body !== "object") return;
  const bodyObj = body as Record<string, unknown>;

  const visitIfBlock = (block: unknown) => {
    if (block && typeof block === "object") {
      visit(block as Record<string, unknown>);
    }
  };

  // v1: sections[].layout.columns[].blocks[]
  if (Array.isArray(bodyObj.sections)) {
    for (const section of bodyObj.sections) {
      const layout = (section as Record<string, unknown> | null)?.layout as
        | Record<string, unknown>
        | undefined;
      const columns = Array.isArray(layout?.columns) ? layout.columns : [];
      for (const column of columns) {
        const blocks = Array.isArray(
          (column as Record<string, unknown> | null)?.blocks,
        )
          ? ((column as Record<string, unknown>).blocks as unknown[])
          : [];
        for (const block of blocks) {
          visitIfBlock(block);
        }
      }
    }
  }

  // Legacy body: blocks[]
  if (Array.isArray(bodyObj.blocks)) {
    for (const block of bodyObj.blocks) {
      visitIfBlock(block);
    }
  }
}

function collectTextFromBlock(
  record: Record<string, unknown>,
  parts: string[],
): void {
  if (
    record.type === "richText" &&
    record.doc &&
    typeof record.doc === "object"
  ) {
    collectTextFromProseMirror(record.doc, parts);
    return;
  }
  if (record.type === "cta") {
    if (typeof record.label === "string") {
      parts.push(record.label);
    }
    if (typeof record.href === "string") {
      parts.push(record.href);
    }
    return;
  }
  if (record.type === "image" && typeof record.alt === "string") {
    parts.push(record.alt);
  }
}

function collectTextFromProseMirror(node: unknown, parts: string[]): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;

  if (typeof record.text === "string") {
    parts.push(record.text);
  }
  // mediaEmbed titles are display-facing free text (see extractPlainText doc
  // comment) — they MUST reach the content filter.
  if (record.type === "mediaEmbed") {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (attrs && typeof attrs.title === "string") {
      parts.push(attrs.title);
    }
  }
  // Image captions render as visible <figcaption> text: same reasoning.
  if (record.type === "imageBlock") {
    const attrs = record.attrs as Record<string, unknown> | undefined;
    if (attrs && typeof attrs.caption === "string") {
      parts.push(attrs.caption);
    }
  }
  if (Array.isArray(record.content)) {
    for (const child of record.content) {
      collectTextFromProseMirror(child, parts);
    }
  }
}
