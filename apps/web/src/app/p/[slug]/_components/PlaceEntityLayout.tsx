"use client";

import type { CSSProperties } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { placeAcceptsBookingRequests } from "@th/types/repos/entity-pages";


import type { EntityPageContentData } from "./EntityPageContent";
import { isRedundantAboutBlock } from "./about-block-dedupe";
import { PlaceHero } from "./headers/PlaceHero";
import { PlaceLogisticsCard, type SidebarLink } from "./PlaceLogisticsCard";
import { PlaceEventsSection } from "./PlaceEventsSection";
import { BlockRenderer } from "./blocks";
import { BlockPageOwnerProvider } from "./blocks/block-page-owner-context";
import {
  CommunityListingNotice,
  placeClaimableFrom,
} from "@/components/community/CommunityListingNotice";
import { resolveEntityPageSurfaceTone } from "./entity-page-theme-vars";
import styles from "./place-entity.module.css";

type PlaceEntity = Extract<
  EntityPageContentData["entity"],
  { type: "PLACE" }
>;

type Props = {
  data: EntityPageContentData & { entity: PlaceEntity };
  themeVars: CSSProperties;
  fontKey: string;
};

/**
 * Priority buckets for the main column. Lower sorts first. Anything not listed
 * keeps its stored order after the known kinds.
 *
 * `booking_info` is pinned to the BOTTOM (> DEFAULT_PRIORITY): on the standard
 * layout the booking *action* is the hero's "Booking request" button (the
 * in-column `request_to_play` is suppressed below), so the static
 * booking-contact card reads best as the page's "how to book / reach us"
 * footer rather than floating mid-column above house rules / amenities.
 *
 * The venue-facts run (`capacity_info` / `house_rules` / `amenities` /
 * `tech_specs`) deliberately has NO entries here — those kinds ride the
 * default bucket in stored (template) order, which already groups them and
 * keeps tech specs with the other advance-a-show facts.
 */
const BLOCK_PRIORITY: Record<string, number> = {
  about: 10,
  photos: 20,
  booking_info: 1000,
};

const DEFAULT_PRIORITY = 500;

function priorityFor(kind: string): number {
  return BLOCK_PRIORITY[kind] ?? DEFAULT_PRIORITY;
}

const DIRECTIONS_RE = /direction|maps?\.google|google\.[^/]+\/maps|\/maps\//i;

function isDirectionsLink(link: { label?: string; url?: string }): boolean {
  const haystack = `${link.label ?? ""} ${link.url ?? ""}`;
  return DIRECTIONS_RE.test(haystack);
}

/**
 * The sidebar owns location, directions, contact, and social links, and the
 * dedicated events section owns upcoming events — so suppress those kinds from
 * the main column:
 *  - every `location_map` block (sidebar owns the map)
 *  - every `upcoming_events` block (PlaceEventsSection owns events)
 *  - every `links` block (its links move into the logistics card)
 */
function isSuppressedByLogistics(block: PageBlockRecord): boolean {
  return (
    block.kind === "location_map" ||
    block.kind === "upcoming_events" ||
    block.kind === "links"
  );
}

/** Normalise a URL for dedup: lowercase host, strip trailing slash + scheme. */
function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Pull social/website links out of every `links` block so they can live in the
 * logistics sidebar. Pure "get directions" links are dropped (the sidebar has a
 * dedicated directions action already), duplicates are collapsed, and any link
 * that matches the venue's own `website` is skipped (the card renders that
 * separately).
 */
function extractSidebarLinks(
  blocks: PageBlockRecord[],
  website?: string | null,
): SidebarLink[] {
  const out: SidebarLink[] = [];
  const seen = new Set<string>();
  if (website?.trim()) seen.add(normalizeUrlKey(website));
  for (const block of blocks) {
    if (block.kind !== "links") continue;
    const data = block.data as
      | { links?: Array<{ label?: string; url?: string }> }
      | null;
    const links = data?.links;
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      const url = typeof link?.url === "string" ? link.url.trim() : "";
      if (!url) continue;
      if (isDirectionsLink(link)) continue;
      const key = normalizeUrlKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: link.label?.trim() || url, url });
    }
  }
  return out;
}

/**
 * Two-column venue profile (the "standard" template). PLACE-scoped: HUMAN / ORG
 * pages never reach here (see EntityPageContent), and a PLACE using a freeform
 * layout takes the block-canvas path instead.
 *
 * Mount only through `EntityPageContent`, which supplies the `entity-page`
 * query container its layout rules measure; without it they never match.
 */
export function PlaceEntityLayout({ data, themeVars, fontKey }: Props) {
  const { page, blocks, entity, communityAttribution } = data;

  const orderedBlocks = blocks
    .map((block, index) => ({ block, index }))
    // `request_to_play` is surfaced by the hero's "Booking request" button on
    // the standard template (see PlaceHero / HeroBookingRequestButton), so drop
    // the redundant in-column block here. This is scoped to the standard PLACE
    // layout ONLY — the freeform block-canvas path (EntityPageContent) still
    // renders `request_to_play`, gated by EntityPageShell.
    // An `about` block that adds nothing beyond the hero bio (equal, or fully
    // contained in it) is suppressed too — the hero already renders that text.
    // An about block carrying MORE than the bio always renders
    // (see about-block-dedupe.ts).
    .filter(
      ({ block }) =>
        !isSuppressedByLogistics(block) &&
        block.kind !== "request_to_play" &&
        !isRedundantAboutBlock(block, page.bio),
    )
    .sort((a, b) => {
      const pa = priorityFor(a.block.kind);
      const pb = priorityFor(b.block.kind);
      if (pa !== pb) return pa - pb;
      return a.index - b.index; // stable within a bucket
    })
    .map(({ block }) => block);

  const sidebarLinks = extractSidebarLinks(blocks, entity.website);

  return (
    <div
      className={styles.placeRoot}
      style={themeVars}
      data-font={fontKey}
      // `.placeRoot` paints the owner's background (Stub cream without one),
      // so graphics that pick colours by surface read this, not the app theme.
      data-surface={resolveEntityPageSurfaceTone(data.theme, true) ?? undefined}
    >
      <PlaceHero page={page} entity={entity} />

      <div className={styles.placeGrid}>
        {/* Main content is first in the DOM so keyboard / screen-reader order
            matches the visual primary column; the grid areas below place the
            sidebar on the right (desktop) or above main (mobile). */}
        <div className={styles.placeMain}>
          {/* Moderators wrote this page and no owner has kept or cleared it
              yet (moderator-place-page D6/D7). The byline carries no date,
              so the edge-cached HTML never differs from the client render. */}
          {communityAttribution ? (
            <CommunityListingNotice
              subject="place"
              lastChangedAt={communityAttribution.lastUpdatedAt}
              placeClaimable={placeClaimableFrom(entity)}
            />
          ) : null}
          {/* Events-first: the venue's own show list (or, when empty, past
              shows + a browse-all link) leads the main column. */}
          <PlaceEventsSection placeId={entity.id} />

          {orderedBlocks.length > 0 && (
            <BlockPageOwnerProvider
              owner={{
                place: {
                  id: entity.id,
                  name: entity.name,
                  acceptsRequests: placeAcceptsBookingRequests(entity),
                  pageSlug: page.slug,
                },
              }}
            >
              {orderedBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </BlockPageOwnerProvider>
          )}
        </div>

        <div className={styles.placeSidebar}>
          <PlaceLogisticsCard
            entity={entity}
            links={sidebarLinks}
            publicArrivalAreas={data.arrivalAreas}
            publicPreview={data.publicPreview}
          />
        </div>
      </div>
    </div>
  );
}
