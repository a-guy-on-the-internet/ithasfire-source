"use client";

import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import { Badge, useTranslations } from "@th/ui";
import { resolveEntityDisplayName } from "../resolve-entity-display-name";
import styles from "../entity-page-shell.module.css";
import { EntityAvatar, EntityBannerImage, usableImageUrl } from "./EntityMedia";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

type Props = {
  page: EntityPageRecord;
  entity: PlaceEntity;
};

/**
 * Type-specific header for PLACE entity pages (freeform stack/grid layout).
 *
 * Renders banner, venue name, city/region address line with map-pin icon,
 * and a "Verified Venue" badge when the page is PUBLISHED. Banner + avatar go
 * through the robust EntityMedia components so a blocked/missing source never
 * shows a broken box or a collapsed avatar.
 */
export function PlacePageHeader({ page, entity }: Props) {
  const t = useTranslations();
  const displayName = resolveEntityDisplayName(page, entity);
  const locationParts = [entity.city, entity.region].filter(Boolean);
  const hasBanner = Boolean(usableImageUrl(page.bannerUrl));

  return (
    <header className={styles.header}>
      <EntityBannerImage src={page.bannerUrl} />

      <div
        className={`${styles.avatarWrap}${hasBanner ? ` ${styles.avatarOverlap}` : ""}`}
      >
        <EntityAvatar src={page.avatarUrl} name={displayName} />
      </div>

      <p className={styles.entityLabel}>{t("places.venueLabel")}</p>
      <h1 className={styles.displayName}>{displayName}</h1>

      {page.bio && <p className={styles.bio}>{page.bio}</p>}

      {/* Address line with pin icon */}
      {locationParts.length > 0 && (
        <p className={styles.addressLine}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          {locationParts.join(", ")}
        </p>
      )}

      {/* Verification badge for published venues */}
      {page.visibility === "PUBLIC" && (
        <div className={styles.verificationRow}>
          <Badge tone="success" variant="soft" size="sm">
            {t("places.verifiedVenue")}
          </Badge>
        </div>
      )}

      {/* The claim / dispute affordance (FR-001 / FR-005 / FR-008) lives in
          the venue hero's `⋯` overflow menu — see PlaceHeroActions, mounted
          from PlaceHero. */}
    </header>
  );
}
