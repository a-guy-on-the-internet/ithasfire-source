"use client";

import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import styles from "../entity-page-shell.module.css";
import {
  EntityAvatar,
  EntityBannerImage,
  usableImageUrl,
} from "./EntityMedia";

type HumanEntity = Extract<EntitySummary, { type: "HUMAN" }>;

type Props = {
  page: EntityPageRecord;
  entity: HumanEntity;
};

/**
 * Type-specific header for HUMAN entity pages.
 *
 * Renders banner, avatar, name, bio, and action buttons
 * ("Book Me" CTA + Follow button — CTA shown when page.bookingEmail is set).
 * Banner + avatar go through the EntityMedia components so all three entity
 * headers share one media treatment and one per-entity theme source.
 */
export function HumanPageHeader({ page, entity }: Props) {
  const displayName = page.displayName ?? entity.name ?? page.slug ?? "";
  const hasBanner = Boolean(usableImageUrl(page.bannerUrl));

  return (
    <header className={styles.header}>
      <EntityBannerImage src={page.bannerUrl} />

      <div
        className={`${styles.avatarWrap}${hasBanner ? ` ${styles.avatarOverlap}` : ""}`}
      >
        <EntityAvatar src={page.avatarUrl} name={displayName} />
      </div>

      <p className={styles.entityLabel}>Person</p>
      <h1 className={styles.displayName}>{displayName}</h1>

      {page.bio && <p className={styles.bio}>{page.bio}</p>}

      {/* Action row: Book Me + Follow */}
      <div className={styles.headerActions}>
        {"bookingEmail" in page && Boolean(page.bookingEmail) && (
          <a
            href={`mailto:${String(page.bookingEmail)}`}
            className={styles.ctaButton}
          >
            Book Me
          </a>
        )}
        <button type="button" className={styles.secondaryButton}>
          Follow
        </button>
      </div>
    </header>
  );
}
