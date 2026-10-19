import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  EntityPageRecord,
  PageBlockRecord,
  PageOwnerType,
} from "@th/types/repos/entity-pages";

import { getDefaultBlockData, isPinnedBlockKind } from "./block-config";
import { normalizeBlockSection } from "./block-sections";
import {
  getAppliedTemplateRevision,
  getPageTemplate,
  getTemplateRevision,
  needsTemplateSeed,
  templateAppliedMarker,
  type TemplateBlockSpec,
} from "./page-templates";

/**
 * The block a template spec seeds: its data override or the kind's default
 * data, its per-kind seed visibility (default true; `stats` seeds hidden,
 * musician-epk FR-004), and `pinned` for a pinned kind. Shared by the
 * template seed and resolveCommunityHandover's Clear, so a cleared page gets
 * exactly what a first seed writes.
 */
export function templateSpecToBlock(spec: TemplateBlockSpec): {
  kind: string;
  data: unknown;
  visible: boolean;
  pinned?: true;
} {
  return {
    kind: spec.kind,
    data: spec.dataOverride ?? getDefaultBlockData(spec.kind),
    visible: spec.visible ?? true,
    ...(isPinnedBlockKind(spec.kind) ? { pinned: true as const } : {}),
  };
}

// ── Deps ───────────────────────────────────────────────────────────────────

export type SeedPageTemplateBlocksDeps = {
  repos: Pick<Repos, "entityPages">;
  logger?: LoggerPort;
};

export interface SeedPageTemplateBlocksInput {
  pageId: string;
  ownerType: PageOwnerType;
  category: string;
  /**
   * Optionally pass the already-loaded page record (as `getMyPage` does) to
   * skip a redundant fetch. When omitted, the page is loaded by id.
   */
  page?: Pick<EntityPageRecord, "id" | "templateAppliedCategories">;
}

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Additively seeds an EntityPage with its (ownerType, category) template's
 * starter blocks (FR-003). Idempotent per (category, template revision):
 *
 *  - No-op when the page's applied revision for `category` already matches
 *    the template's current revision (bare category marker = revision 1;
 *    `"<category>@<N>"` markers = revision N — see page-templates.ts).
 *  - A page at an OLDER applied revision considers ONLY the kinds introduced
 *    after it (`sinceRevision`), never the base set — so a template block the
 *    owner deliberately deleted (hard delete, no tombstone) is not
 *    resurrected by a later revision bump. Newly-introduced kinds therefore
 *    seed exactly once per page.
 *  - Never edits, reorders, or deletes an existing block; only appends kinds
 *    the page does not already have.
 *  - The block inserts AND the applied-marker update are atomic and
 *    race-guarded inside `repos.entityPages.applyTemplateSeed`.
 *
 * Returns the newly-appended blocks (may be empty).
 */
export async function seedPageTemplateBlocks(
  deps: SeedPageTemplateBlocksDeps,
  input: SeedPageTemplateBlocksInput,
): Promise<PageBlockRecord[]> {
  const page =
    input.page ?? (await deps.repos.entityPages.getById(input.pageId));
  if (!page) return [];

  // Cheap pre-check for the common (already-current) case; the authoritative
  // guard runs again inside the transaction.
  if (
    !needsTemplateSeed(
      page.templateAppliedCategories,
      input.ownerType,
      input.category,
    )
  ) {
    return [];
  }

  const appliedRevision = getAppliedTemplateRevision(
    page.templateAppliedCategories,
    input.category,
  );
  const currentRevision = getTemplateRevision(input.ownerType, input.category);

  // Never seeded (revision 0) → the full template. Older revision → only the
  // kinds introduced after it (one-shot additivity; see the doc comment).
  const template = getPageTemplate(input.ownerType, input.category).filter(
    (spec) => (spec.sinceRevision ?? 1) > appliedRevision,
  );

  // Filter to kinds not already present. We still call applyTemplateSeed even
  // when nothing is left to add, so the current revision is recorded as
  // applied and we don't re-run this every editor load.
  const existing = await deps.repos.entityPages.listBlocks(input.pageId);
  const presentKinds = new Set(existing.map((block) => block.kind));
  // A PINNED kind is "present" only when a MAIN-section row carries it: the
  // public page drops every non-main block before expansion, so a stray copy
  // under "memberships" would otherwise satisfy this check, mark the revision
  // applied, and leave the page with no track record for good. The adapter
  // repeats this rule inside its transaction (see `pinned` on the port).
  const presentPinnedKinds = new Set(
    existing
      .filter((block) => normalizeBlockSection(block.section) === "main")
      .map((block) => block.kind),
  );
  const isPresent = (kind: string): boolean =>
    isPinnedBlockKind(kind)
      ? presentPinnedKinds.has(kind)
      : presentKinds.has(kind);

  const candidates = template
    .filter((spec) => !isPresent(spec.kind))
    .map(templateSpecToBlock);

  return deps.repos.entityPages.applyTemplateSeed({
    pageId: input.pageId,
    category: input.category,
    appliedMarker: templateAppliedMarker(input.category, currentRevision),
    blocks: candidates,
  });
}
