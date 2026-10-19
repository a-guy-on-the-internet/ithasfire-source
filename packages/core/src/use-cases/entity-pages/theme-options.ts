import { z } from "zod";

export const ENTITY_PAGE_FONT_KEYS = [
  "montserrat",
  "system",
  "serif",
  "mono",
  "editorial",
  "condensed",
] as const;

// `standard` is the polished, industry-standard template (owner picks it to
// hand rendering back to the app). `stack` / `grid` remain the freeform,
// owner-controlled block-canvas modes.
export const ENTITY_PAGE_LAYOUT_KEYS = ["standard", "stack", "grid"] as const;

export type EntityPageFontKey = (typeof ENTITY_PAGE_FONT_KEYS)[number];
export type EntityPageLayoutKey = (typeof ENTITY_PAGE_LAYOUT_KEYS)[number];

/** Owner types that carry an entity page. Mirrors PageOwnerType in @th/types. */
export type EntityPageOwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

/**
 * The layout a page falls back to when its theme has no explicit `layoutKey`.
 *
 * Every owner type now defaults to the app-controlled `standard` template so a
 * page gets the polished, industry-standard profile out of the box:
 *   - PLACE   → the venue template (map + logistics sidebar).
 *   - HUMAN   → the single-column, shows-first musician/artist template.
 *   - ORG     → the two-column promoter/collective template.
 * The freeform `stack` / `grid` canvases remain valid *explicit* choices an
 * owner can opt into; they are never the default.
 */
export function resolveDefaultEntityPageLayoutKey(
  _ownerType: EntityPageOwnerType,
): EntityPageLayoutKey {
  return "standard";
}

export const entityPageFontKeySchema = z.enum(ENTITY_PAGE_FONT_KEYS);
export const entityPageLayoutKeySchema = z.enum(ENTITY_PAGE_LAYOUT_KEYS);

const normalizeThemeKeyInput = (value: unknown): unknown =>
  typeof value === "string" ? value.trim().toLowerCase() : value;

export const entityPageFontKeyInputSchema = z.preprocess(
  normalizeThemeKeyInput,
  entityPageFontKeySchema.nullable(),
);

export const entityPageLayoutKeyInputSchema = z.preprocess(
  normalizeThemeKeyInput,
  entityPageLayoutKeySchema.nullable(),
);

export function normalizeEntityPageFontKey(
  value: unknown,
): EntityPageFontKey | null {
  const parsed = entityPageFontKeyInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function normalizeEntityPageLayoutKey(
  value: unknown,
): EntityPageLayoutKey | null {
  const parsed = entityPageLayoutKeyInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
