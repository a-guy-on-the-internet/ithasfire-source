"use client";

import { useState } from "react";
import { Users2, BadgeCheck, Mail } from "lucide-react";
import type {
  EntityPageRecord,
  EntitySummary,
} from "@th/types/repos/entity-pages";
import { performerAcceptsBookingRequests } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { FollowButton } from "../FollowButton";
import { getInitials } from "./EntityMedia";
import { HeroPerformerBookingButton } from "./HeroPerformerBookingButton";
import { ProfileShareButton } from "../ProfileShareButton";
import { EntityHeroActions } from "../EntityHeroActions";
import placeStyles from "../place-entity.module.css";

type OrgEntity = Extract<EntitySummary, { type: "ORGANIZATION" }>;

type Props = {
  page: EntityPageRecord;
  entity: OrgEntity;
  /** Anchor id of the sidebar contact section the "Contact" CTA jumps to. */
  contactAnchorId: string;
  /**
   * Whether the sidebar contact section will render. The "Contact" jump link is
   * only shown when true, so it never scrolls to a non-existent anchor.
   */
  hasContact: boolean;
  /** Genre chips lifted out of the `genre_tags` block (hero owns them). */
  genres?: string[];
};

/**
 * Category-aware eyebrow label key. The org's stored `category` (an explicit,
 * opt-in classification — never auto-resolved for orgs) selects the label:
 * "band" and "collective" get their own, everything else (incl. "generic" /
 * "promoter" / null) keeps the default promoter label.
 */
function orgLabelKey(category: string | null): string {
  switch (category) {
    case "band":
      return "profileStd.bandLabel";
    case "collective":
      return "profileStd.collectiveLabel";
    default:
      return "profileStd.promoterLabel";
  }
}

function usableImageUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("data:")
  ) {
    return trimmed;
  }
  return undefined;
}

/**
 * Promoter / collective hero for the ORGANIZATION standard template. Mirrors
 * PlaceHero's structure but leads its action row with the primary Follow CTA,
 * then a Contact jump link to the sidebar contact section, then Share.
 *
 * The at-a-glance rail carries the promoter label plus the org's trust badge
 * (when the entity exposes one).
 */
export function OrgHero({
  page,
  entity,
  contactAnchorId,
  hasContact,
  genres = [],
}: Props) {
  const t = useTranslations();
  const displayName = page.displayName ?? entity.name ?? page.slug ?? "";
  const initials = displayName ? getInitials(displayName) : "";
  const labelKey = orgLabelKey(page.category);

  const bannerUrl = usableImageUrl(page.bannerUrl);
  const avatarUrl = usableImageUrl(page.avatarUrl);
  const [bannerLoaded, setBannerLoaded] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  const trustBadge = entity.trustBadgeLabel?.trim() || null;

  // "Request to book" gate (organizer-booking-requests FR-009): the server
  // sets `acceptsBookingRequests` only when the org act is performer-enabled
  // AND opted in. The Contact jump link stays — it is the page's generic
  // contact affordance, distinct from the booking-request flow.
  const canRequestToBook = performerAcceptsBookingRequests(entity);

  return (
    <>
      <div className={placeStyles.heroFrame}>
        <div className={placeStyles.hero}>
          <div className={placeStyles.heroFallback} aria-hidden />
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className={placeStyles.heroImg}
              data-loaded={bannerLoaded ? "true" : "false"}
              ref={(node) => {
                if (node?.complete && node.naturalWidth > 0)
                  setBannerLoaded(true);
              }}
              onLoad={(e) => {
                if (e.currentTarget.naturalWidth > 0) setBannerLoaded(true);
              }}
              onError={() => setBannerLoaded(false)}
            />
          )}
          <div className={placeStyles.heroScrim} aria-hidden />
        </div>

        <div className={placeStyles.heroOverlay}>
          <div className={placeStyles.avatarWrap}>
            <span className={placeStyles.avatarInitials} aria-hidden>
              {initials || "•"}
            </span>
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                className={placeStyles.avatarImg}
                data-loaded={avatarLoaded ? "true" : "false"}
                ref={(node) => {
                  if (node?.complete && node.naturalWidth > 0)
                    setAvatarLoaded(true);
                }}
                onLoad={(e) => {
                  if (e.currentTarget.naturalWidth > 0) setAvatarLoaded(true);
                }}
                onError={() => setAvatarLoaded(false)}
              />
            )}
          </div>

          <div className={placeStyles.heroIdentity}>
            <h1 className={placeStyles.displayName}>{displayName}</h1>

            <div className={placeStyles.chipStrip}>
              <span className={placeStyles.chip}>
                <Users2
                  size={15}
                  className={placeStyles.chipIcon}
                  aria-hidden
                />
                {t(labelKey)}
              </span>
              {trustBadge && (
                <span className={placeStyles.chip}>
                  <BadgeCheck
                    size={15}
                    className={placeStyles.chipIcon}
                    aria-hidden
                  />
                  {trustBadge}
                </span>
              )}
              {genres.map((genre) => (
                <span key={genre} className={placeStyles.chip}>
                  {genre}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={placeStyles.heroBelow}>
        {page.bio && <p className={placeStyles.bio}>{page.bio}</p>}

        <div className={placeStyles.heroActions}>
          {/* Primary booking CTA leads the row (same placement grammar as
              PlaceHero) — the shared `.bookingButton ~ .followWrap` rule
              demotes Follow to the secondary outline automatically. */}
          {canRequestToBook && (
            <HeroPerformerBookingButton
              performerOwnerType="org"
              performerOwnerId={entity.id}
              performerName={displayName}
            />
          )}
          <FollowButton entityPageId={page.id} variant="primary" />
          {hasContact && (
            <a
              href={`#${contactAnchorId}`}
              className={placeStyles.directionsButton}
            >
              <Mail size={16} aria-hidden />
              {t("places.contact")}
            </a>
          )}
          <ProfileShareButton title={displayName || String(t(labelKey))} />
          {/* Copy link + Report — the actions with no other home on the page.
              Last in the row so the booking / follow primaries lead. */}
          <EntityHeroActions
            subjectType="ORGANIZATION"
            subjectId={entity.id}
            subjectName={displayName}
          />
        </div>
      </div>
    </>
  );
}
