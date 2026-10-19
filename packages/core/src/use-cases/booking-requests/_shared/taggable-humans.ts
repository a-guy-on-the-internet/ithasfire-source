import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// Who may be TAGGED onto a booking request's bill (lineup-booking-requests
// v2, FR-002): "Tagged humans must be taggable = what
// `search.autocompleteAdmin` already surfaces (no new eligibility concept)."
//
// That procedure (transport `unifiedSearch.autocompleteAdmin`, types
// ["human"], `publishedOnly` defaulting to true) reads the search index, and
// a human is in the index's surfaced set when BOTH hold:
//   · the human's status is ACTIVE — `humans.listForSearchIndex` and
//     `indexHumansByIds` (core search/build-search-index.ts) only index
//     ACTIVE humans;
//   · the human owns an EntityPage with visibility PUBLIC — the full rebuild
//     indexes HUMAN pages `visibility: "PUBLIC"` only, and both search
//     adapters filter `type != 'human' OR is_public = TRUE`.
// This module re-asks exactly that of the DATABASE (two batched reads), not
// of the index: core must not depend on the search port for an authorization
// decision, and the index can lag a suspension or an unpublish.
//
// Known drift, recorded rather than copied: the INCREMENTAL reindex
// (`indexHumansByIds`) stamps `isPublic: true` for ANY page, so between a
// page going UNLISTED/PRIVATE and the next full rebuild, the index may still
// surface that human. This check is the stricter, intended predicate — a
// human who unpublished their page is not taggable even if search still
// shows them for a while.
// ─────────────────────────────────────────────────────────────────────────────

export type TaggableHuman = {
  humanId: string;
  /**
   * The name search would show: the page's displayName, else Human.name
   * (same precedence as the search document's title). Null when neither is
   * set.
   */
  displayName: string | null;
};

/**
 * The taggable subset of `humanIds`, keyed by id. ONE `humans.getByIds` and
 * ONE `entityPages.getByOwners` for the whole bill — never per act. Ids that
 * do not resolve, are not ACTIVE, or have no PUBLIC HUMAN page are simply
 * absent from the result; the caller decides what that means.
 */
export async function resolveTaggableHumans(
  repos: Pick<Repos, "humans" | "entityPages">,
  humanIds: readonly string[],
): Promise<Map<string, TaggableHuman>> {
  const unique = [...new Set(humanIds)];
  const taggable = new Map<string, TaggableHuman>();
  if (unique.length === 0) return taggable;

  const [humans, pages] = await Promise.all([
    repos.humans.getByIds(unique),
    repos.entityPages.getByOwners("HUMAN", unique),
  ]);

  const publicPageByOwner = new Map(
    pages
      .filter((page) => page.ownerType === "HUMAN" && page.visibility === "PUBLIC")
      .map((page) => [page.ownerId, page] as const),
  );

  for (const human of humans) {
    if (human.status !== "ACTIVE") continue;
    const page = publicPageByOwner.get(human.id);
    if (!page) continue;
    const displayName =
      page.displayName?.trim() || human.name?.trim() || null;
    taggable.set(human.id, { humanId: human.id, displayName });
  }
  return taggable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Groups (lineup-booking-requests v3, L17): "Taggable groups = the same
// eligibility search.autocompleteAdmin already surfaces for orgs."
//
// Verified against the index (2026-09-30), NOT the human rule: an
// organization document is in the surfaced set when the org's status is
// ACTIVE — `indexAllOrganizations` walks `organizations.listActive`,
// `indexOrganizationsByIds` removes any non-ACTIVE org's document, and
// neither search adapter gates organization documents on `is_public` (that
// gate is `type != 'human' OR is_public`). So a group with no EntityPage, or
// a PRIVATE one, IS taggable — exactly as it is findable in the picker. The
// page only feeds the display name.
//
// Known drift, recorded rather than copied: the Postgres search adapter also
// withholds an org whose every OWNER is banned (derived from Human.status at
// query time, 2026-09-29). That rule lives in the search SQL with no port of
// its own yet, so this check does not repeat it; a banned owner's org is
// normally SUSPENDED by moderation as well, which this check does refuse.
// ─────────────────────────────────────────────────────────────────────────────

export type TaggableGroup = {
  orgId: string;
  /** The org page's displayName, else Organization.name; null when neither. */
  displayName: string | null;
};

/**
 * The taggable subset of `orgIds`, keyed by id: ACTIVE organizations. ONE
 * `organizations.getByIds` and ONE `entityPages.getByOwners` for the whole
 * bill. Unknown, SUSPENDED and ARCHIVED ids are absent; the caller decides
 * what that means.
 */
export async function resolveTaggableGroups(
  repos: Pick<Repos, "organizations" | "entityPages">,
  orgIds: readonly string[],
): Promise<Map<string, TaggableGroup>> {
  const unique = [...new Set(orgIds)];
  const taggable = new Map<string, TaggableGroup>();
  if (unique.length === 0) return taggable;

  const [orgs, pages] = await Promise.all([
    repos.organizations.getByIds(unique),
    repos.entityPages.getByOwners("ORGANIZATION", unique),
  ]);
  const pageByOwner = new Map(
    pages
      .filter((page) => page.ownerType === "ORGANIZATION")
      .map((page) => [page.ownerId, page] as const),
  );

  for (const org of orgs) {
    if (org.status !== "ACTIVE") continue;
    const page = pageByOwner.get(org.id);
    // Only a PUBLIC page's name stands in for the org's own (the same rule
    // `resolveBillIdentities` renders with).
    const pageName =
      page?.visibility === "PUBLIC" ? page.displayName?.trim() : undefined;
    taggable.set(org.id, {
      orgId: org.id,
      displayName: pageName || org.name?.trim() || null,
    });
  }
  return taggable;
}
