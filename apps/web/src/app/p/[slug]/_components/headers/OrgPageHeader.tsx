"use client";

import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import { Badge } from "@th/ui";
import styles from "../entity-page-shell.module.css";
import {
  EntityAvatar,
  EntityBannerImage,
  usableImageUrl,
} from "./EntityMedia";

type OrgEntity = Extract<EntitySummary, { type: "ORGANIZATION" }>;

type Props = {
  page: EntityPageRecord;
  entity: OrgEntity;
};

/**
 * Type-specific header for ORGANIZATION entity pages.
 *
 * Renders banner, avatar (square), org name, bio, trust-tier badge,
 * and a member-count line. Banner + avatar go through the EntityMedia
 * components so all three entity headers share one media treatment and one
 * per-entity theme source.
 */
export function OrgPageHeader({ page, entity }: Props) {
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

      <p className={styles.entityLabel}>Promoter</p>
      <h1 className={styles.displayName}>{displayName}</h1>

      {page.bio && <p className={styles.bio}>{page.bio}</p>}

      {/* Trust badge */}
      {entity.trustBadgeLabel && (
        <div className={styles.trustBadge}>
          <Badge tone="success" variant="soft" size="sm">
            {entity.trustBadgeLabel}
          </Badge>
        </div>
      )}

      {/* Member count */}
      <p className={styles.memberCount}>Group</p>
    </header>
  );
}
