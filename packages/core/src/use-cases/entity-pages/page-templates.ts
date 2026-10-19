import type { PageOwnerType } from "@th/types/repos/entity-pages";

import { isValidBlockKind } from "./block-config";

/**
 * Per-(ownerType, category) starter templates.
 *
 * Mirrors the block-config.ts pattern — a code-defined registry, NO DB table.
 * Each template is an ORDERED list of block kinds; on the owner's editor load
 * a page seeds any of these kinds it does not already have, appended at the
 * end (see seed-page-template-blocks.ts + get-my-page.ts).
 *
 * ── TEMPLATE REVISIONS (one-shot additivity for new kinds) ────────────────
 * Seeding runs at most ONCE PER (category, revision) — not per editor load.
 * Block deletion is a hard delete (no tombstone), so a per-load re-seed
 * would resurrect blocks the owner deliberately removed; instead, when a NEW
 * kind is added to an existing template, tag it with `sinceRevision: N`
 * (N = previous template revision + 1). Already-seeded pages then gain
 * EXACTLY the kinds introduced after their applied revision, exactly once,
 * and record the new revision marker (`"<category>@<N>"`-style entries in
 * `EntityPage.templateAppliedCategories`; the bare category string means
 * revision 1). A kind added WITHOUT a `sinceRevision` bump reaches only
 * never-seeded pages. See getTemplateRevision / getAppliedTemplateRevision.
 *
 * ── CRITICAL DESIGN NOTE ──────────────────────────────────────────────────
 * Seeding is per-category and additive (a category is seeded at most once per
 * revision — FR-003). Because a page can resolve STRAIGHT to a non-generic
 * category (never passing through "generic" first), every template must be
 * SELF-CONTAINED: it lists the universal identity blocks AND its own
 * tier-specific blocks. Listing the universal kinds in multiple templates is
 * correct and safe — the additive skip-by-kind step means a category
 * transition (e.g. generic → performer) only appends the kinds not already
 * present (no duplicates).
 *
 * ── PROFILE TIERS (deliberate deviation from the original FR-003 text) ────
 * The original musician-epk spec resolved a brand-new performer straight to
 * "musician" (the full EPK). Templates now encode a three-tier ladder:
 *   - HUMAN "generic"   → minimal identity floor for non-performers.
 *   - HUMAN "performer" → the working-act middle tier; this is what a HUMAN
 *     with performer mode enabled resolves to BY DEFAULT (see
 *     resolveCategory).
 *   - HUMAN "musician"  → the full EPK. Stays registered and reachable for
 *     explicitly-categorized pages / a future archetype picker — it is no
 *     longer the automatic performer default. Its kinds are a superset of
 *     "performer", so existing musician-template pages gain nothing when the
 *     default resolution flips (the additive seed skips every present kind).
 * ORGANIZATION mirrors the same shape: "generic" is the minimal floor, with
 * "promoter" (events-forward) and "collective" (mission-forward) as
 * explicitly-selected supersets. ORG resolution stays "generic".
 */

export type TemplateBlockSpec = {
  kind: string;
  /**
   * Optional per-kind default-data override. None are needed for v1 — the
   * seed use case falls back to `getDefaultBlockData(kind)` when absent.
   */
  dataOverride?: Record<string, unknown>;
  /**
   * Per-kind seed visibility. Defaults to `true` when absent. Set `false` for
   * blocks that must be OPT-IN / off by default on the public page — e.g. the
   * musician `stats` block (musician-epk FR-004): the owner explicitly toggles
   * it on once eligible.
   */
  visible?: boolean;
  /**
   * Template revision that introduced this kind (default 1 — the template's
   * original block set). Tag kinds added to an EXISTING template with the next
   * revision number so already-seeded pages pick them up exactly once (see the
   * header comment). Never lower an existing tag.
   */
  sinceRevision?: number;
};

/**
 * A template kind list entry: a bare kind string (revision-1 original), or a
 * kind + the revision that introduced it.
 */
type TemplateKindEntry = string | { kind: string; sinceRevision: number };

/**
 * Kinds seeded hidden (visible: false) so they are opt-in on the public page.
 * `stats` (musician-epk FR-004) — verified numbers stay private until the
 * owner chooses to reveal them.
 */
const SEED_HIDDEN_KINDS: ReadonlySet<string> = new Set(["stats"]);

// ── Ordered kind lists ───────────────────────────────────────────────────

/** Universal identity starter shared by every template below. */
const UNIVERSAL_STARTER = ["about", "links", "photos", "upcoming_events"] as const;

const HUMAN_GENERIC = [...UNIVERSAL_STARTER] as const;

/**
 * The working-act middle tier — the default for performer-mode HUMANs (see
 * resolveCategory). Self-contained: universal identity blocks interleaved
 * with the core performer media/booking blocks. Deliberately a strict SUBSET
 * of HUMAN_MUSICIAN so a musician-template page gains nothing if the default
 * resolution ever seeds "performer" on top of it.
 */
const HUMAN_PERFORMER = [
  "about",
  "music",
  "video",
  "photos",
  "genre_tags",
  "upcoming_events",
  "booking_info",
  "links",
] as const;

const HUMAN_MUSICIAN = [
  // Full EPK, media pulled above the fold — matches how the standard
  // HumanEntityLayout zones already order things, and keeps the freeform
  // canvas from burying media under the bio. Self-contained (universal
  // identity kinds interleaved, not prefixed).
  "about",
  "music",
  "tracks",
  "video",
  "photos",
  "press",
  "stats",
  "upcoming_events",
  "shows",
  "past_shows",
  "genre_tags",
  "rider",
  // Dedicated booking-contact block for artists (musician-epk FR-007) — the
  // #1 most commonly forgotten EPK section. Requires booking_info to include
  // "HUMAN" in its block-config ownerTypes.
  "booking_info",
  "links",
] as const;

const PLACE_VENUE = [
  // Lean universal starter, then the venue-specific blocks (FR-002).
  "about",
  "location_map",
  "capacity_info",
  "house_rules",
  "amenities",
  // The venue-side rider: the technical facts an artist needs to advance a
  // show (PA / monitors / backline / stage / power / load-in). Sits with the
  // other venue-facts blocks so the "what you're walking into" read is one
  // continuous run before the photo break. `sinceRevision: 2` — added after
  // the original venue template shipped, so already-seeded venue pages gain
  // it (appended at the end) exactly once on their next editor load.
  { kind: "tech_specs", sinceRevision: 2 },
  "photos",
  // The venue's track record (venue-track-record-and-review-switch FR-011,
  // rulings R6 / R9): what has HAPPENED here — shows hosted, first and last,
  // cadence, who has played — sits directly after the photo break and ABOVE
  // the two testimony blocks, so a performer reads the door's record before
  // anyone's opinion of the room. PINNED (block-config): seeded once, never
  // removable or hideable. `sinceRevision: 4` — added after rate_venue (rev
  // 3) shipped, so already-seeded venue pages gain it (appended at the end)
  // exactly once on their next editor load; the owner may then move it.
  { kind: "track_record", sinceRevision: 4 },
  // Crowd-sourced performer-review aggregates (booking-review-data-weave
  // FR-006) sit directly ABOVE the request-to-play CTA: a performer reads
  // "what other performers reported" and then hits the form. Server-derived
  // (content comes from PlaceStats.publicSnapshot only); seeds VISIBLE — the
  // owner can hide it like any block, but the same aggregates remain on
  // performer-facing surfaces they don't control.
  "venue_stats",
  // Verified-attendee testimony aggregates (attendee-reviews FR-005) sit
  // directly BESIDE the performer venue_stats — a fan reads "what other
  // attendees reported" next to "what performers reported". Server-derived
  // (content comes from the ReviewAggregate PLACE snapshot only); seeds VISIBLE
  // like venue_stats.
  "audience_stats",
  // Role-forked "Rate this venue" CTA (venue-rating-block-and-owner-optin
  // FR-001) sits right after the audience_stats aggregate — a fan reads "what
  // other attendees reported" and then has a one-tap way to add their own take.
  // `sinceRevision: 3` — added after tech_specs (rev 2) shipped, so already-
  // seeded venue pages gain it (appended at the end) exactly once on their next
  // editor load.
  { kind: "rate_venue", sinceRevision: 3 },
  // The booking request form leads, then the static booking-contact card sits
  // UNDERNEATH it — the CTA to submit a request comes first, the "here's how to
  // reach us" details follow.
  "request_to_play",
  "booking_info",
] as const;

const ORG_GENERIC = [
  // Minimal identity floor for uncategorized orgs. `upcoming_events` is newer
  // than the original template but carries NO `sinceRevision` tag: it reaches
  // only pages whose "generic" category has not yet been template-seeded.
  // Deliberately NOT retro-bumped to a new revision — pages seeded after its
  // addition already got it, and a hard-deleted block is indistinguishable
  // from a never-seeded one, so a revision bump here would resurrect
  // owner-deleted upcoming_events blocks on those pages.
  "about",
  "links",
  "upcoming_events",
] as const;

/**
 * Events-forward org tier. Self-contained superset of ORG_GENERIC.
 */
const ORG_PROMOTER = [
  "about",
  "links",
  "upcoming_events",
  "photos",
  "past_events",
  "managed_places",
] as const;

/**
 * Mission-forward org tier. Self-contained superset of ORG_GENERIC.
 */
const ORG_COLLECTIVE = [
  "about",
  "links",
  "upcoming_events",
  "team",
  "mission",
  "managed_places",
  "past_events",
] as const;

/**
 * Band / act org tier — the performer spine (EPK media + booking) laid over the
 * org frame so a group can present as a single act. Self-contained superset of
 * ORG_GENERIC (about, links, upcoming_events). Every kind here is ORG-valid per
 * block-config (music/video/press/genre_tags/booking_info are dual/tri-owner as
 * of the "band" archetype; about/links/upcoming_events/photos are universal;
 * team is org-only). Order mirrors the HUMAN performer/musician spine —
 * identity, media above the fold, then who's-in-the-band + booking + photos.
 * Reachable ONLY via an explicit stored category ("band"), never auto-resolved
 * (see resolveCategory).
 */
const ORG_BAND = [
  "about",
  "links",
  "upcoming_events",
  "music",
  "video",
  "press",
  "genre_tags",
  "team",
  "booking_info",
  "photos",
] as const;

function toSpecs(
  entries: readonly TemplateKindEntry[],
): readonly TemplateBlockSpec[] {
  return entries.map((entry) => {
    const spec: TemplateBlockSpec =
      typeof entry === "string" ? { kind: entry } : { ...entry };
    return SEED_HIDDEN_KINDS.has(spec.kind)
      ? { ...spec, visible: false }
      : spec;
  });
}

/**
 * The template registry keyed by `${ownerType}:${category}`. Categories are
 * free-form strings (FR-001); an unknown key resolves to an empty template.
 */
export const PAGE_TEMPLATES: Readonly<
  Record<string, readonly TemplateBlockSpec[]>
> = {
  "HUMAN:generic": toSpecs(HUMAN_GENERIC),
  "HUMAN:performer": toSpecs(HUMAN_PERFORMER),
  "HUMAN:musician": toSpecs(HUMAN_MUSICIAN),
  "PLACE:venue": toSpecs(PLACE_VENUE),
  "ORGANIZATION:generic": toSpecs(ORG_GENERIC),
  "ORGANIZATION:promoter": toSpecs(ORG_PROMOTER),
  "ORGANIZATION:collective": toSpecs(ORG_COLLECTIVE),
  "ORGANIZATION:band": toSpecs(ORG_BAND),
};

function templateKey(ownerType: PageOwnerType, category: string): string {
  return `${ownerType}:${category}`;
}

/**
 * Pure lookup — the ordered template block specs for a (ownerType, category).
 * Returns `[]` for any unregistered combination (a valid, no-op template).
 */
export function getPageTemplate(
  ownerType: PageOwnerType,
  category: string,
): readonly TemplateBlockSpec[] {
  return PAGE_TEMPLATES[templateKey(ownerType, category)] ?? [];
}

// ── Template revisions ────────────────────────────────────────────────────
// One-shot additivity for kinds added to an already-shipped template (see the
// header comment). The applied-state store is the existing free-form
// `EntityPage.templateAppliedCategories` String[] — NO schema change:
//   - the bare category string  ("venue")   = revision 1 applied
//   - a versioned marker        ("venue@2") = revision 2 applied
// Category names are code-defined (resolveCategory / PAGE_TEMPLATES keys) and
// never contain "@", so the marker encoding is unambiguous.

/**
 * The current revision of a template: the highest `sinceRevision` across its
 * specs (1 for a template with no tagged kinds, or no template at all).
 */
export function getTemplateRevision(
  ownerType: PageOwnerType,
  category: string,
): number {
  return getPageTemplate(ownerType, category).reduce(
    (max, spec) => Math.max(max, spec.sinceRevision ?? 1),
    1,
  );
}

/**
 * The marker recorded in `templateAppliedCategories` when (category, revision)
 * has been seeded. Revision 1 stays the bare category string so every
 * already-applied page in the wild is read as revision 1 without a backfill.
 */
export function templateAppliedMarker(
  category: string,
  revision: number,
): string {
  return revision <= 1 ? category : `${category}@${revision}`;
}

/**
 * The highest template revision already applied to a page for `category`,
 * derived from its `templateAppliedCategories` entries. 0 = never seeded.
 */
export function getAppliedTemplateRevision(
  applied: readonly string[],
  category: string,
): number {
  const prefix = `${category}@`;
  let max = 0;
  for (const entry of applied) {
    if (entry === category) {
      max = Math.max(max, 1);
    } else if (entry.startsWith(prefix)) {
      const revision = Number(entry.slice(prefix.length));
      if (Number.isInteger(revision) && revision > max) {
        max = revision;
      }
    }
  }
  return max;
}

/**
 * True when the page's applied revision for `category` lags the template's
 * current revision — i.e. an (incremental or first-time) seed should run.
 * Shared by the get-my-page pre-check and seedPageTemplateBlocks itself.
 */
export function needsTemplateSeed(
  applied: readonly string[],
  ownerType: PageOwnerType,
  category: string,
): boolean {
  return (
    getAppliedTemplateRevision(applied, category) <
    getTemplateRevision(ownerType, category)
  );
}

/**
 * Category resolution (FR-005) — pure, no I/O. The caller supplies the
 * already-resolved performer-mode flag (only meaningful for HUMAN).
 *
 * Three-tier note: performer-mode HUMANs resolve to "performer" (the working-
 * act middle tier), NOT "musician" — a deliberate deviation from the original
 * musician-epk FR-003 text (see the header comment). "musician" remains a
 * registered, reachable template for explicitly-categorized pages / a future
 * archetype picker.
 */
export function resolveCategory(
  ownerType: PageOwnerType,
  opts: { performerEnabled: boolean },
): string {
  switch (ownerType) {
    case "HUMAN":
      return opts.performerEnabled ? "performer" : "generic";
    case "PLACE":
      return "venue";
    case "ORGANIZATION":
      // ORG always auto-resolves to "generic" — there is NO org-type/archetype
      // field to distinguish a promoter/collective/band, so we never guess.
      // The non-generic org templates ("promoter", "collective", "band") are
      // reachable ONLY via an explicit stored category (a future org-type /
      // archetype picker), never by auto-resolution. Do NOT add a heuristic
      // here — "ORGANIZATION:band" in particular must stay opt-in.
      return "generic";
    default: {
      const _exhaustive: never = ownerType;
      return _exhaustive;
    }
  }
}

/**
 * Validates that every kind in every registered template is a real block kind
 * for that owner type. Exported for the registry test (FR-007) and safe to
 * call at module boundaries — returns the list of violations rather than
 * throwing, so it never breaks a prod import.
 */
export function findTemplateKindViolations(): string[] {
  const violations: string[] = [];
  for (const [key, specs] of Object.entries(PAGE_TEMPLATES)) {
    const [ownerType] = key.split(":") as [PageOwnerType, string];
    for (const spec of specs) {
      if (!isValidBlockKind(ownerType, spec.kind)) {
        violations.push(`${key} -> ${spec.kind}`);
      }
    }
  }
  return violations;
}
