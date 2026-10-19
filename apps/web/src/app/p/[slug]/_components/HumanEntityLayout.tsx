"use client";

import type { CSSProperties } from "react";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { useAnchorId } from "@/hooks/useAnchorId";

import type { EntityPageContentData } from "./EntityPageContent";
import { isRedundantAboutBlock } from "./about-block-dedupe";
import { HumanHero } from "./headers/HumanHero";
import { BlockRenderer } from "./blocks";
import { BlockPageOwnerProvider } from "./blocks/block-page-owner-context";
import { BlockEmpty } from "./blocks/block-primitives";
import {
  getSafeExternalHref,
  getSafeMailtoHref,
  getSafeTelHref,
} from "./blocks/safe-block-url";
import { FollowButton } from "./FollowButton";
import placeStyles from "./place-entity.module.css";
import styles from "./human-entity.module.css";

type HumanEntity = Extract<
  EntityPageContentData["entity"],
  { type: "HUMAN" }
>;

type Props = {
  data: EntityPageContentData & { entity: HumanEntity };
  themeVars: CSSProperties;
  fontKey: string;
};

/** Read a block's `data` as a plain object (blocks store arbitrary JSON). */
function blockData(block: PageBlockRecord): Record<string, unknown> {
  const d = block.data;
  return typeof d === "object" && d !== null && !Array.isArray(d)
    ? (d as Record<string, unknown>)
    : {};
}

/** Trim, drop empties, and case-insensitively dedupe genre labels. */
function dedupeGenreLabels(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = typeof value === "string" ? value.trim() : "";
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/** Genre chips lifted out of every `genre_tags` block for the hero rail. */
function extractGenres(blocks: PageBlockRecord[]): string[] {
  const raw: unknown[] = [];
  for (const block of blocks) {
    if (block.kind !== "genre_tags") continue;
    const tags = blockData(block).tags;
    if (Array.isArray(tags)) raw.push(...tags);
  }
  return dedupeGenreLabels(raw);
}

/**
 * True when a `booking_info` block will render at least one actionable contact
 * means (email / phone / external booking URL). Uses the SAME safe-href
 * predicates `BookingInfoBlock` renders with, so the hero Booking CTA can never
 * point at a section that shows none of them. (Blocks here are already
 * visible-only — getPublicPage filters, and the editor preview filters too.)
 */
function bookingBlockHasContact(block: PageBlockRecord): boolean {
  if (block.kind !== "booking_info") return false;
  const d = blockData(block);
  return Boolean(
    getSafeMailtoHref(d.contactEmail) ||
      getSafeTelHref(d.contactPhone) ||
      getSafeExternalHref(d.bookingUrl),
  );
}

/** A server-built `shows` block only renders with its trusted marker + events. */
function hasRenderableShows(block: PageBlockRecord): boolean {
  const d = blockData(block);
  return d.dataSource === "shows" && Array.isArray(d.events) && d.events.length > 0;
}

/** A static `upcoming_events` block renders a list only when it carries events. */
function hasRenderableUpcoming(block: PageBlockRecord): boolean {
  const events = blockData(block).events;
  return Array.isArray(events) && events.length > 0;
}

/**
 * HUMAN "standard" template — a single-column, mobile-first performer profile.
 * HUMAN-scoped: PLACE / ORG pages never reach here (see EntityPageContent), and
 * a HUMAN page on a freeform layout takes the block-canvas path instead.
 *
 * Zone order (each zone reuses the existing block renderers — this component is
 * orchestration, not re-implemented content):
 *   Hero → Upcoming shows (LEADS) → Music → Video → About → Photos → More
 *   (rider / stats) → Past shows (demoted) → Connect & booking footer.
 *
 * `genre_tags` is suppressed from the flow — its tags render as hero chips.
 * `shows` + `upcoming_events` are pulled into the dedicated leading shows zone,
 * which falls back to a "follow for alerts" prompt when there is nothing on the
 * calendar, so the page never leads with a dead section.
 *
 * Mount only through `EntityPageContent`, which supplies the `entity-page`
 * query container its layout rules measure; without it they never match.
 */
export function HumanEntityLayout({ data, themeVars, fontKey }: Props) {
  const t = useTranslations();
  const { page, blocks, entity } = data;
  // Per-INSTANCE anchor id for the footer "Connect & booking" section (the
  // hero CTA's scroll target). A module constant broke the moment the entity
  // page editor started mounting a hidden authoring copy of this layout beside
  // the visible preview: two `#human-booking` elements, and the hero's
  // `getElementById` resolved to the hidden one, so the CTA scrolled nowhere.
  const bookingAnchorId = useAnchorId("human-booking");

  // Owner-curated `genre_tags` block wins; otherwise fall back to the genres
  // the human picked in account settings (threaded on the entity summary).
  const blockGenres = extractGenres(blocks);
  const genres =
    blockGenres.length > 0
      ? blockGenres
      : dedupeGenreLabels(entity.genreTags ?? []);

  const hasBookingContact = blocks.some(bookingBlockHasContact);

  // Partition blocks into zones by kind, preserving stored order within a zone.
  const showBlocks: PageBlockRecord[] = [];
  const musicBlocks: PageBlockRecord[] = [];
  const videoBlocks: PageBlockRecord[] = [];
  const aboutBlocks: PageBlockRecord[] = [];
  const photoBlocks: PageBlockRecord[] = [];
  const moreBlocks: PageBlockRecord[] = [];
  const pastBlocks: PageBlockRecord[] = [];
  const footerBlocks: PageBlockRecord[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "genre_tags":
        // Suppressed — surfaced as hero chips.
        break;
      case "shows":
      case "upcoming_events":
        showBlocks.push(block);
        break;
      case "music":
      case "tracks":
        musicBlocks.push(block);
        break;
      case "video":
        videoBlocks.push(block);
        break;
      case "about":
        // An `about` block that adds nothing beyond the hero bio (equal, or
        // fully contained in it) is suppressed — the hero already renders that
        // text. One carrying MORE always renders (see about-block-dedupe.ts).
        if (!isRedundantAboutBlock(block, page.bio)) {
          aboutBlocks.push(block);
        }
        break;
      case "press":
        aboutBlocks.push(block);
        break;
      case "photos":
        photoBlocks.push(block);
        break;
      case "past_shows":
        pastBlocks.push(block);
        break;
      case "links":
      case "booking_info":
        footerBlocks.push(block);
        break;
      default:
        // rider, stats, and any future kind — low-emphasis "more" zone.
        moreBlocks.push(block);
        break;
    }
  }

  const hasLiveShows =
    showBlocks.some(hasRenderableShows) ||
    showBlocks.some(hasRenderableUpcoming);

  return (
    <div className={placeStyles.placeRoot} style={themeVars} data-font={fontKey}>
      <HumanHero
        page={page}
        entity={entity}
        genres={genres}
        bookingAnchorId={bookingAnchorId}
        hasBooking={hasBookingContact}
      />

      <BlockPageOwnerProvider owner={{ place: null }}>
        <div className={styles.humanBody}>
          {/* ── Upcoming shows — LEADS ─────────────────────────────────── */}
          <section className={styles.zone} aria-label={String(t("profileStd.upcomingShows"))}>
            {hasLiveShows ? (
              showBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))
            ) : (
              <div className={placeStyles.eventsSection}>
                <h2 className={placeStyles.sectionHeading}>
                  {t("profileStd.upcomingShows")}
                </h2>
                <div className={placeStyles.eventsEmpty}>
                  <BlockEmpty>{t("profileStd.followShowsPrompt")}</BlockEmpty>
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

          {/* ── Music ──────────────────────────────────────────────────── */}
          {musicBlocks.length > 0 && (
            <section className={styles.zone}>
              {musicBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── Video ──────────────────────────────────────────────────── */}
          {videoBlocks.length > 0 && (
            <section className={styles.zone}>
              {videoBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── About (+ press) ────────────────────────────────────────── */}
          {aboutBlocks.length > 0 && (
            <section className={styles.zone}>
              {aboutBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── Photos strip ───────────────────────────────────────────── */}
          {photoBlocks.length > 0 && (
            <section className={`${styles.zone} ${styles.photoZone}`}>
              {photoBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── More (rider / stats / future kinds) ────────────────────── */}
          {moreBlocks.length > 0 && (
            <section className={styles.zone}>
              {moreBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── Past shows — demoted + dimmed ──────────────────────────── */}
          {pastBlocks.length > 0 && (
            <section className={`${styles.zone} ${styles.pastShowsZone}`}>
              {pastBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}

          {/* ── Connect & booking footer — low emphasis ───────────────── */}
          {footerBlocks.length > 0 && (
            // tabIndex={-1}: programmatic focus target for the hero Booking
            // CTA, so keyboard / SR context lands here after the scroll.
            <section
              id={bookingAnchorId}
              tabIndex={-1}
              className={styles.footerZone}
            >
              <p className={styles.footerLabel}>
                {t("profileStd.connectAndBooking")}
              </p>
              {footerBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </section>
          )}
        </div>
      </BlockPageOwnerProvider>
    </div>
  );
}
