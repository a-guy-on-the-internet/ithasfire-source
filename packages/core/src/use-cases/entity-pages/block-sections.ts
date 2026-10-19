import { z } from "zod";

/**
 * Page surfaces a PageBlock can belong to (recurring-memberships spec):
 *
 *   - "main"        — the default page body (every pre-existing block).
 *   - "memberships" — the member-gated Membership tab on /p/[slug]. Rendered
 *     only to viewers with an ACTIVE membership on one of the owner's tiers;
 *     non-members see the tier pitch instead.
 *
 * Free-form String at the DB level (same convention as PageBlock.kind); this
 * module is the authority on allowed values, so growing the vocabulary needs
 * no migration.
 */
export const PAGE_BLOCK_SECTIONS = ["main", "memberships"] as const;

export type PageBlockSection = (typeof PAGE_BLOCK_SECTIONS)[number];

export const DEFAULT_PAGE_BLOCK_SECTION: PageBlockSection = "main";

export const pageBlockSectionSchema = z.enum(PAGE_BLOCK_SECTIONS);

export function isValidBlockSection(
  section: string,
): section is PageBlockSection {
  return (PAGE_BLOCK_SECTIONS as readonly string[]).includes(section);
}

/**
 * Normalize a stored section value for rendering: unknown/absent values fall
 * back to "main" so a forward-vocabulary row can never vanish from every
 * surface at once.
 */
export function normalizeBlockSection(
  section: string | null | undefined,
): PageBlockSection {
  return section != null && isValidBlockSection(section)
    ? section
    : DEFAULT_PAGE_BLOCK_SECTION;
}
