import { sanitizeText } from "../../../lib/slug-utils";

/**
 * Derive the PUBLIC page slug for a place's `EntityPage`.
 *
 * Format: `{sanitized-name}-{first 8 hex chars of the place id}` — FLAT, a
 * single URL segment, e.g. `backstage-nashville-81d4c5b3`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A PLACE HAS EXACTLY ONE SLUG, AND THIS FUNCTION MINTS IT.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   `EntityPage.slug`  ← THIS function. FLAT (`x-a1b2c3d4`). It is what
 *                        `/places/[slug]` and `/p/[slug]` resolve on
 *                        (`EntityPagesRepo.getBySlug` / `resolveSlugHistory`).
 *                        Globally `@unique` across ALL owner types.
 *
 * A place USED to carry a second one, `Place.slug`: MULTI-SEGMENT
 * (`us/tn/x--a1b2c3d4e5`, literal `/` included), a DIRECTORY KEY that NOTHING
 * ROUTED ON. Confusing the two was a recurring defect class (commit 1d3061dc
 * fixed seven call sites of it) — `/places/[slug]` and `/p/[slug]` are SINGLE
 * non-catch-all segments, so feeding them a `Place.slug` failed twice over,
 * wrong path shape AND wrong column, and the venue 404'd with no public page
 * at all. The column is deprecated: nothing mints or reads it, and the
 * `packages/core/src/__tests__/no-place-slug-readers.test.ts` gate keeps it
 * that way. Do not reintroduce a second slug. Anything that mints a place must
 * mint an `EntityPage` whose slug comes from HERE.
 *
 * The 8-char suffix is the uniqueness guard: two venues can share a name (and
 * a city), so the name alone is not a key. It is taken from the place's own
 * UUID, which makes the result deterministic — the same (name, id) always
 * produces the same slug, so a repair pass can recompute what a create path
 * should have written.
 *
 * Falls back to `place-<suffix>` when the name sanitises to nothing (a venue
 * named entirely in punctuation or in a script `sanitizeText` strips).
 */
export function buildPageSlug(name: string, placeId: string): string {
  const base = sanitizeText(name);
  const suffix = placeId.replace(/-/g, "").slice(0, 8);
  if (!base) return `place-${suffix}`;
  return `${base}-${suffix}`;
}
