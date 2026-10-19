"use client";

import type { CSSProperties } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { useAnchorId } from "@/hooks/useAnchorId";

import type { EntityPageContentData } from "./EntityPageContent";
import { isRedundantAboutBlock } from "./about-block-dedupe";
import { OrgHero } from "./headers/OrgHero";
import { BlockRenderer } from "./blocks";
import { BlockPageOwnerProvider } from "./blocks/block-page-owner-context";
import { BlockEmpty } from "./blocks/block-primitives";
import { FollowButton } from "./FollowButton";
import placeStyles from "./place-entity.module.css";
import styles from "./org-entity.module.css";

type OrgEntity = Extract<
  EntityPageContentData["entity"],
  { type: "ORGANIZATION" }
>;

type Props = {
  data: EntityPageContentData & { entity: OrgEntity };
  themeVars: CSSProperties;
  fontKey: string;
};

function blockData(block: PageBlockRecord): Record<string, unknown> {
  const d = block.data;
  return typeof d === "object" && d !== null && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : {};
}

/** A static `upcoming_events` block renders a list only when it carries events. */
function hasRenderableUpcoming(block: PageBlockRecord): boolean {
  const events = blockData(block).events;
  return Array.isArray(events) && events.length > 0;
}

/** Genre chips lifted out of every `genre_tags` block for the hero rail. */
function extractGenres(blocks: PageBlockRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.kind !== "genre_tags") continue;
    const tags = blockData(block).tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      const label = typeof tag === "string" ? tag.trim() : "";
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(label);
    }
  }
  return out;
}

/**
 * ORGANIZATION "standard" template — a two-column, events-first promoter /
 * collective profile. ORG-scoped: PLACE / HUMAN pages never reach here (see
 * EntityPageContent), and an ORG page on a freeform layout takes the
 * block-canvas path instead.
 *
 * Layout (each zone reuses the existing block renderers — orchestration, not
 * re-implemented content):
 *   Hero (+ genre chips)
 *   Main column:  Upcoming events (LEADS) → Music / Video (media) → Photos
 *   Sidebar:      About / Mission → Press → Contact & links → Booking → Team
 *
 * The upcoming-events zone falls back to a "follow for alerts" prompt when the
 * calendar is empty, so the page never leads with a dead section. On mobile the
 * grid collapses to a single column with the calendar first.
 *
 * The media (music/video), press, booking, and genre zones are ADDITIVE for the
 * "band" org archetype (its template seeds those kinds): a promoter / collective
 * / generic org that lacks them renders exactly as before — every zone is
 * conditional on having blocks. `genre_tags` is suppressed from the body and
 * lifted into the hero chips (like the HUMAN layout).
 *
 * `managed_places` ("Rooms we run") and `past_events` are SUPPRESSED here: both
 * are backend stubs that only render a "coming soon" placeholder (StubBlocks),
 * so the standard template hides them rather than headlining a flagship zone
 * with no content. Re-surface them once their server data pipelines land.
 *
 * Mount only through `EntityPageContent`, which supplies the `entity-page`
 * query container its layout rules measure; without it they never match.
 */
export function OrgEntityLayout({ data, themeVars, fontKey }: Props) {
  const t = useTranslations();
  const { page, blocks, entity } = data;
  // Per-INSTANCE anchor id for the sidebar contact section (the hero
  // "Contact" jump target). As a module constant it collided the moment the
  // entity page editor began mounting a hidden authoring copy of this layout
  // beside the visible preview, and the hero's `#org-contact` fragment
  // resolved to the hidden one.
  const contactAnchorId = useAnchorId("org-contact");

  const genres = extractGenres(blocks);

  // Main-column zones.
  const upcomingBlocks: PageBlockRecord[] = [];
  const mediaBlocks: PageBlockRecord[] = [];
  const photoBlocks: PageBlockRecord[] = [];
  // Sidebar zones.
  const aboutBlocks: PageBlockRecord[] = [];
  const pressBlocks: PageBlockRecord[] = [];
  const contactBlocks: PageBlockRecord[] = [];
  const bookingBlocks: PageBlockRecord[] = [];
  const teamBlocks: PageBlockRecord[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "genre_tags":
        // Suppressed — surfaced as hero chips (see extractGenres).
        break;
      case "upcoming_events":
        upcomingBlocks.push(block);
        break;
      case "music":
      case "video":
        // Band-archetype media zone — main column, between events and photos.
        mediaBlocks.push(block);
        break;
      case "managed_places":
      case "past_events":
        // Suppressed — backend stubs with no data pipeline yet (see header
        // comment). Rendering them would headline a "coming soon" placeholder.
        break;
      case "photos":
        photoBlocks.push(block);
        break;
      case "about":
        // An `about` block that adds nothing beyond the hero bio (equal, or
        // fully contained in it) is suppressed — the hero already renders that
        // text. One carrying MORE always renders (see about-block-dedupe.ts).
        if (!isRedundantAboutBlock(block, page.bio)) {
          aboutBlocks.push(block);
        }
        break;
      case "mission":
        aboutBlocks.push(block);
        break;
      case "press":
        pressBlocks.push(block);
        break;
      case "links":
        contactBlocks.push(block);
        break;
      case "booking_info":
        bookingBlocks.push(block);
        break;
      case "team":
        teamBlocks.push(block);
        break;
      default:
        // Any other kind falls into the sidebar "about" column so it is never
        // silently dropped.
        aboutBlocks.push(block);
        break;
    }
  }

  const hasUpcoming = upcomingBlocks.some(hasRenderableUpcoming);
  // The hero "Contact" jump target scrolls to the sidebar contact/booking
  // anchor, so it must appear whenever either the links or booking zone renders.
  const hasContact = contactBlocks.length > 0 || bookingBlocks.length > 0;

  return (
    <div className={placeStyles.placeRoot} style={themeVars} data-font={fontKey}>
      <OrgHero
        page={page}
        entity={entity}
        contactAnchorId={contactAnchorId}
        hasContact={hasContact}
        genres={genres}
      />

      <BlockPageOwnerProvider owner={{ place: null }}>
        <div className={styles.orgGrid}>
          {/* Main column first in the DOM so keyboard / SR order leads with the
              live calendar; the grid areas place the sidebar on the right. */}
          <div className={styles.orgMain}>
            {/* ── Upcoming events — LEADS ──────────────────────────────── */}
            <section aria-label={String(t("places.upcomingEvents"))}>
              {hasUpcoming ? (
                upcomingBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))
              ) : (
                <div className={placeStyles.eventsSection}>
                  <h2 className={placeStyles.sectionHeading}>
                    {t("places.upcomingEvents")}
                  </h2>
                  <div className={placeStyles.eventsEmpty}>
                    <BlockEmpty>{t("profileStd.followEventsPrompt")}</BlockEmpty>
                    <div className={placeStyles.eventsActions}>
                      <FollowButton entityPageId={page.id} variant="primary" />
                      <a href="/events" className={placeStyles.browseLink}>
                        {t("places.browseEvents")}
                        <span aria-hidden>&#8599;</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* ── Media (music / video) — band archetype ───────────────── */}
            {mediaBlocks.length > 0 && (
              <section>
                {mediaBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}

            {/* ── Photos strip ─────────────────────────────────────────── */}
            {photoBlocks.length > 0 && (
              <section>
                {photoBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}
          </div>

          <aside className={styles.orgSidebar}>
            {/* ── About / Mission ──────────────────────────────────────── */}
            {aboutBlocks.length > 0 && (
              <section>
                {aboutBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}

            {/* ── Press ────────────────────────────────────────────────── */}
            {pressBlocks.length > 0 && (
              <section>
                {pressBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}

            {/* ── Contact & booking (hero "Contact" jump target) ───────── */}
            {hasContact && (
              <section id={contactAnchorId} className={styles.sidebarAnchor}>
                {contactBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
                {bookingBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}

            {/* ── Who runs it (team) ───────────────────────────────────── */}
            {teamBlocks.length > 0 && (
              <section>
                {teamBlocks.map((block) => (
                  <BlockRenderer key={block.id} block={block} />
                ))}
              </section>
            )}
          </aside>
        </div>
      </BlockPageOwnerProvider>
    </div>
  );
}
