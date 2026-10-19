"use client";

import { useState } from "react";
import { MapPin, Building2, BadgeCheck, Users } from "lucide-react";
import {
  placeAcceptsBookingRequests,
  type EntityPageRecord,
  type EntitySummary,
} from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { DirectionsDropdown } from "@/components/actions/DirectionsDropdown";
import {
  placeAllowsDirections,
  resolvePlaceLocationPrivacy,
} from "@/lib/places/location-privacy";
import { resolveEntityDisplayName } from "../resolve-entity-display-name";
import { EditPageButton } from "../EditPageButton";
import { FollowButton } from "../FollowButton";
import { PlaceHeroActions } from "../PlaceHeroActions";
import { getInitials } from "./EntityMedia";
import { HeroBookingRequestButton } from "./HeroBookingRequestButton";
import { HeroRateVenueButton } from "./HeroRateVenueButton";
import { HeroClaimPlaceButton } from "./HeroClaimPlaceButton";
import styles from "../place-entity.module.css";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

type Props = {
  page: EntityPageRecord;
  entity: PlaceEntity;
};

/** Only treat a banner/avatar URL as usable when it is a real http(s)/data URL. */
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
 * Venue hero: a full-bleed base image with the venue identity overlaid on a
 * dark bottom-up scrim (functional legibility, not decoration). The base has a
 * real fallback chain:
 *   1. page.bannerUrl (revealed only once it positively loads)
 *   2. a map preview of the venue's coordinates (only when there is no banner)
 *   3. a flat brand-tinted surface
 *
 * The venue name + at-a-glance chips sit bottom-left over the scrim, so the
 * flat-surface base intentionally omits the giant initials (the overlaid name
 * replaces them). The avatar straddles the hero's bottom edge. Bio + CTAs live
 * just below the hero.
 */
export function PlaceHero({ page, entity }: Props) {
  const t = useTranslations();
  const displayName = resolveEntityDisplayName(page, entity);
  const initials = displayName ? getInitials(displayName) : "";

  const bannerUrl = usableImageUrl(page.bannerUrl);
  const avatarUrl = usableImageUrl(page.avatarUrl);
  // Reveal the banner only once it has positively loaded. Cross-origin images
  // blocked by ORB (and some 404s) never dispatch an `error` event, so an
  // onError-based fallback would leave a broken-image box. Instead we render a
  // map/initials fallback as the base layer and fade the banner in over it
  // on a successful load — a blocked/missing banner simply never appears.
  const [bannerLoaded, setBannerLoaded] = useState(false);
  const [avatarLoaded, setAvatarLoaded] = useState(false);

  // Multi-provider directions — the same shared component the event detail page
  // uses. Coords power the exact-destination links; address alone still yields a
  // maps search + copy affordance. Hidden when the venue has neither.
  //
  // ADDRESS PRIVACY (place-address-withholding): EXACT VENUES ONLY. A venue
  // with an obfuscated circle still arrives here with non-null `lat`/`lng` —
  // they are the deliberately-offset circle CENTRE, not the venue — so a bare
  // `typeof === "number"` test put a "Get directions" button and a copy-address
  // item on a venue that withholds its address, routing someone to a point it
  // never agreed to publish. `resolvePlaceLocationPrivacy` is fail-closed: an
  // entity summary that omits the flags reads as withheld, not exact.
  const privacy = resolvePlaceLocationPrivacy(entity);
  const directionsAddress =
    privacy.kind === "exact" ? entity.formattedAddress?.trim() || null : null;
  const directionsCoords =
    privacy.kind === "exact" && privacy.lat !== null && privacy.lng !== null
      ? {
          latitude: privacy.lat,
          longitude: privacy.lng,
          label: directionsAddress ?? displayName,
        }
      : null;
  const showDirections = placeAllowsDirections(privacy, directionsAddress);

  const locationParts = [entity.city, entity.region].filter(Boolean);
  // Trust chip reflects venue *verification*, not page visibility. `verified`
  // is the derived public flag (true only when the place is VERIFIED).
  const isVerified = entity.verified === true;
  const hasCapacity = typeof entity.capacity === "number";
  // Booking CTA gate — shares one predicate with EntityPageShell's
  // `request_to_play` gate (verified AND owner opt-in) so the hero button and
  // the (suppressed-here) block can never drift.
  const acceptsBookingRequests = placeAcceptsBookingRequests(entity);

  return (
    <>
      <div className={styles.heroFrame}>
        <div className={styles.hero}>
          {/* Base layer: a flat brand-tinted surface under the banner. We
              deliberately do NOT mount a map here — the sidebar owns the single
              live map — and the giant initials are omitted because the name
              overlay below already carries the venue name. */}
          <div className={styles.heroFallback} aria-hidden />
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className={styles.heroImg}
              data-loaded={bannerLoaded ? "true" : "false"}
              // A cached image can finish loading before React attaches onLoad,
              // so also confirm via the ref for the already-complete case.
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
          {/* Functional bottom-up scrim: keeps the white overlay text legible
              over a photo OR the map base. Not decorative. */}
          <div className={styles.heroScrim} aria-hidden />
        </div>

        {/* Identity overlay — sits over the scrim, bottom-left. The avatar
            straddles the hero's bottom edge; it lives on the frame (not the
            overflow-hidden hero) so its overhang is not clipped. */}
        <div className={styles.heroOverlay}>
          <div className={styles.avatarWrap}>
            <span className={styles.avatarInitials} aria-hidden>
              {initials || "•"}
            </span>
            {avatarUrl && (
              <img
                src={avatarUrl}
                alt=""
                className={styles.avatarImg}
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

          <div className={styles.heroIdentity}>
            <h1 className={styles.displayName}>{displayName}</h1>

            <div className={styles.chipStrip}>
              {hasCapacity && (
                <span className={styles.chip}>
                  <Users size={15} className={styles.chipIcon} aria-hidden />
                  {t("places.capacityChip", {
                    count: entity.capacity!.toLocaleString(),
                  })}
                </span>
              )}
              {locationParts.length > 0 && (
                <span className={styles.chip}>
                  <MapPin size={15} className={styles.chipIcon} aria-hidden />
                  {locationParts.join(", ")}
                </span>
              )}
              <span className={styles.chip}>
                <Building2 size={15} className={styles.chipIcon} aria-hidden />
                {t("places.venueLabel")}
              </span>
              {isVerified && (
                <span className={styles.chip}>
                  <BadgeCheck
                    size={15}
                    className={styles.chipIcon}
                    aria-hidden
                  />
                  {t("places.verified")}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.heroBelow}>
        {page.bio && <p className={styles.bio}>{page.bio}</p>}

        <div className={styles.heroActions}>
          {acceptsBookingRequests && (
            <HeroBookingRequestButton
              placeId={entity.id}
              placeName={displayName}
            />
          )}

          <FollowButton entityPageId={page.id} variant="primary" />

          {/* Shared multi-provider directions menu — identical mechanism to the
              event detail page. It ships its own Swiss trigger + menu styling. */}
          {showDirections && (
            <DirectionsDropdown
              coords={directionsCoords}
              address={directionsAddress ?? undefined}
              labels={{
                trigger: String(t("places.getDirections")),
                // The Location sidebar carries this same control with the
                // same visible text. Naming the venue here keeps the two
                // apart in a screen reader's control list; the sidebar's sits
                // under a visible "Location" heading and keeps the bare
                // label. Contains the visible string in order (WCAG 2.5.3).
                triggerAriaLabel: String(
                  t("places.getDirectionsToAria", { name: displayName }),
                ),
                google: String(t("eventDetail.directionsGoogle")),
                apple: String(t("eventDetail.directionsApple")),
                waze: String(t("eventDetail.directionsWaze")),
                copyAddress: String(t("eventDetail.copyAddress")),
                copied: String(t("eventDetail.copied")),
              }}
            />
          )}

          {/* Claim entry point, in the row only while the place is claimable
              (it used to be buried third in the `⋯` overflow). Outlined
              secondary chip, ahead of Rate. Until the client eligibility query
              answers it follows the server's `claimable` (the same claim-state
              rule that query uses), so the row does not shift when it lands. */}
          <HeroClaimPlaceButton
            placeId={entity.id}
            placeName={displayName}
            initiallyClaimable={entity.claimable === true}
          />

          {/* Rating entry point, promoted out of the optional `rate_venue`
              block so it is reachable without scrolling. Secondary weight —
              after the booking / follow primaries and Directions, and kept
              among the PUBLIC actions, ahead of the owner-only editor jump. */}
          <HeroRateVenueButton placeId={entity.id} placeName={displayName} />

          {/* Owner-only editor jump. Viewer-aware — it renders nothing for
              anonymous viewers and non-owners, so the row closes up around it.
              It wears the same outlined secondary chip as Directions, so for
              an owner it reads as one more venue page option. */}
          <EditPageButton placeId={entity.id} />

          {/* Secondary actions with no other home on the page — share, copy
              link, request transfer, report. Last in the row so the
              booking + follow primaries keep the reading order. */}
          <PlaceHeroActions
            placeId={entity.id}
            placeName={displayName}
            shareTitle={displayName}
          />
        </div>
      </div>
    </>
  );
}
