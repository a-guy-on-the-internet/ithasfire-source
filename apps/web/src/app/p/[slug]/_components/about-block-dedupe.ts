import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/**
 * About-vs-hero-bio dedupe for the standard entity templates.
 *
 * The PLACE / HUMAN / ORG heroes render `page.bio`, and owners typically paste
 * the same paragraph into their `about` block — so the standard layouts would
 * show the identical text twice. When the about block adds nothing beyond the
 * hero bio (equal after whitespace normalisation, or fully contained in the
 * bio), the layouts keep the hero bio and suppress the redundant AboutBlock.
 * An about block that carries MORE than the bio (e.g. the bio is a truncation
 * of the full about paragraph) always renders — suppressing it would drop the
 * extra text entirely.
 *
 * Scoped to `kind === "about"` on the standard templates only — the freeform
 * block canvas is owner-controlled and renders whatever is stored.
 */

/** Collapse whitespace runs, trim, and case-fold for a layout-insensitive compare. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Read the about block's `content` string (blocks store arbitrary JSON). */
function aboutContent(block: PageBlockRecord): string | null {
  const data = block.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const content = (data as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

/**
 * True when `block` is an `about` block that adds nothing beyond the hero bio:
 * its text equals the bio, or the bio fully contains it (after normalising
 * whitespace). An about block that carries MORE than the bio is never flagged.
 */
export function isRedundantAboutBlock(
  block: PageBlockRecord,
  heroBio: string | null | undefined,
): boolean {
  if (block.kind !== "about") return false;
  if (!heroBio) return false;

  const content = aboutContent(block);
  if (!content) return false;

  const about = normalizeText(content);
  const bio = normalizeText(heroBio);
  if (!about || !bio) return false;

  return about === bio || bio.includes(about);
}
