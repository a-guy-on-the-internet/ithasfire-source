"use client";

import { ArrowUpRight, Globe, Phone, Link2 } from "lucide-react";
import type { EntitySummary } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { isMapEnabled } from "@/config/maps";
import { LocationMapPreview } from "@/components/maps/LocationMapPreview";
import { ArrivalAreasLegend } from "@/components/maps/ArrivalAreasLayer";
import {
  GettingThereList,
  useArrivalAreaSelection,
} from "@/components/maps/GettingThereList";
import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";
import { DirectionsDropdown } from "@/components/actions/DirectionsDropdown";
import {
  placeAllowsDirections,
  resolvePlaceLocationPrivacy,
} from "@/lib/places/location-privacy";
import { getSafeExternalHref, getSafeTelHref } from "./blocks/safe-block-url";
import { useViewerPlaceArrivalAreas } from "./use-viewer-place-arrival-areas";
import styles from "./place-entity.module.css";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

/** A social / website link surfaced in the sidebar contact section. */
export type SidebarLink = {
  label: string;
  url: string;
};

type Props = {
  entity: PlaceEntity;
  /** Social / website links lifted out of the main-column `links` block(s). */
  links?: SidebarLink[];
  /**
   * The anonymous, cache-safe arrival areas the server rendered
   * (arrival-areas FR-006, NFR-001). The viewer's own list (a manager sees
   * load-in, and the areas of a place that withholds its address) replaces
   * it after hydration, from a `private, no-store` POST.
   */
  publicArrivalAreas?: VisibleArrivalArea[];
  /**
   * The page editor's public-page preview: skip the viewer probe so the
   * preview shows only the anonymous list a stranger sees, never the
   * manager's own (load-in, a withheld place's areas).
   */
  publicPreview?: boolean;
};

const NO_AREAS: VisibleArrivalArea[] = [];

/** Strip the protocol + leading www. for a compact, human display host. */
function displayHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Sticky sidebar "logistics" card for a venue: location, contact (website,
 * phone, socials), and — only when the venue actually publishes an address —
 * a get-directions action. Owns location + contact so the main column can
 * suppress duplicate location_map / links blocks.
 *
 * ── ADDRESS PRIVACY (place-address-withholding) ─────────────────────────────
 *
 * Three states, decided ONCE by `resolvePlaceLocationPrivacy`, which treats
 * anything it cannot positively read as withheld:
 *
 *   exact   → today's behaviour: pin map, full address, directions.
 *   area    → dashed circle over an offset centre. No address, no pin, no
 *             directions, no copy-address. Exactly what an obscured EVENT
 *             already renders.
 *   hidden  → NO MAP AT ALL. A bordered band carrying the area name and two
 *             plain lines.
 *
 * `entity.formattedAddress` is already redacted server-side, so the address
 * paragraph below would be blank for a withheld venue even without this — but
 * the map and the directions menu would NOT have been: for a venue with a
 * circle, `entity.lat/lng` is a non-null OFFSET point, and the old code drew a
 * pin on it and offered to route someone to it. That is the leak this file
 * exists to have closed: not the address on screen, but a product telling
 * somebody to drive to a house that never agreed to be found.
 *
 * Renders nothing when the venue has neither a location to describe nor any
 * contact detail.
 */
export function PlaceLogisticsCard({
  entity,
  links,
  publicArrivalAreas,
  publicPreview = false,
}: Props) {
  const t = useTranslations();
  const privacy = resolvePlaceLocationPrivacy(entity);

  // Arrival areas: the viewer's list when the probe returned one, else the
  // anonymous list from the server. Nothing renders when both are empty
  // (also what the feature gate being off produces).
  const viewerAreas = useViewerPlaceArrivalAreas(
    entity.id,
    !publicPreview,
  );
  const areas = viewerAreas ?? publicArrivalAreas ?? NO_AREAS;
  const areaSelection = useArrivalAreaSelection(areas);
  const hasAreas = areas.length > 0;
  const mapAreas = hasAreas
    ? {
        areas,
        selectedId: areaSelection.selectedId,
        onSelect: areaSelection.selectFromMap,
      }
    : undefined;

  // Only ever read off the EXACT branch. A withheld venue has a null
  // `formattedAddress` from the server anyway; reading it behind the branch
  // means a future server regression cannot put it back on screen.
  const address =
    privacy.kind === "exact" ? entity.formattedAddress?.trim() || null : null;

  const directionsCoords =
    privacy.kind === "exact" && privacy.lat !== null && privacy.lng !== null
      ? {
          latitude: privacy.lat,
          longitude: privacy.lng,
          label: address ?? entity.name,
        }
      : null;
  const showDirections = placeAllowsDirections(privacy, address);

  const websiteHref = getSafeExternalHref(entity.website);
  const phone = entity.phone?.trim() || null;
  const telHref = getSafeTelHref(entity.phone);
  const safeLinks = (links ?? [])
    .map((link) => ({ label: link.label, url: getSafeExternalHref(link.url) }))
    .filter((link): link is SidebarLink => Boolean(link.url));

  const hasContact =
    Boolean(websiteHref) || Boolean(telHref) || safeLinks.length > 0;

  // A fully-hidden venue still has a location section: the area band IS the
  // location. It only disappears when there is no area to name either.
  const hasLocation =
    privacy.kind === "exact"
      ? directionsCoords !== null || Boolean(address)
      : privacy.kind === "area" || Boolean(privacy.areaLabel);

  // The legend explains the map's paint, so it shows only when a map does:
  // an exact place with coordinates or an approximate circle, with tiles
  // configured. Without a map the "Getting there" list carries the areas.
  const mapShown =
    isMapEnabled &&
    ((privacy.kind === "exact" && directionsCoords !== null) ||
      privacy.kind === "area");

  if (!hasLocation && !hasContact && !hasAreas) {
    return null;
  }

  return (
    <aside className={styles.logisticsCard} aria-label={t("places.location")}>
      <h2 className={styles.logisticsHeading}>{t("places.location")}</h2>

      {privacy.kind === "exact" && directionsCoords && (
        <div className={styles.logisticsMapLink}>
          <LocationMapPreview
            latitude={privacy.lat}
            longitude={privacy.lng}
            label={entity.name}
            height={180}
            arrivalAreas={mapAreas}
          />
        </div>
      )}

      {/* Withheld WITH a circle: the same renderer an obscured event uses.
          `preObfuscated` is load-bearing — the centre arrived already offset
          from `redactPlaceLocation`, and letting the map jitter it a second
          time can push the real venue outside its own drawn circle. */}
      {privacy.kind === "area" && (
        <div
          className={styles.logisticsMapLink}
          data-testid="place-location-area-map"
        >
          <LocationMapPreview
            latitude={privacy.lat}
            longitude={privacy.lng}
            label={entity.name}
            isExact={false}
            radiusMeters={privacy.radiusMeters}
            preObfuscated
            height={180}
            arrivalAreas={mapAreas}
          />
        </div>
      )}

      {hasAreas && mapShown && (
        <ArrivalAreasLegend areas={areas} />
      )}

      {address && <p className={styles.logisticsAddress}>{address}</p>}

      {/* The area band. Carries the whole location for a fully-hidden venue and
          captions the circle for an approximate one. */}
      {privacy.kind !== "exact" && (
        <div
          className={styles.areaBand}
          data-testid="place-location-area-band"
          data-state={privacy.kind}
        >
          <p className={styles.areaKicker}>
            {privacy.kind === "area"
              ? t("places.locationApproxKicker")
              : t("places.locationAreaKicker")}
          </p>
          <p className={styles.areaName}>
            {privacy.areaLabel ?? t("places.locationAreaUnknown")}
          </p>
          <p className={styles.areaBody}>
            {privacy.kind === "area"
              ? t("places.locationApproxBody")
              : t("places.locationWithheldBody")}
          </p>
          <p className={styles.areaBody}>{t("places.locationWithheldWhere")}</p>
        </div>
      )}

      {/* Shared multi-provider directions menu — identical mechanism to the
          event detail page (Google / Apple / Waze / copy address). EXACT ONLY:
          the offset centre of a withheld venue is deliberately not the venue,
          so there is nothing to navigate to and nothing to copy. */}
      {showDirections && (
        <DirectionsDropdown
          coords={directionsCoords}
          address={address ?? undefined}
          labels={{
            trigger: String(t("places.getDirections")),
            google: String(t("eventDetail.directionsGoogle")),
            apple: String(t("eventDetail.directionsApple")),
            waze: String(t("eventDetail.directionsWaze")),
            copyAddress: String(t("eventDetail.copyAddress")),
            copied: String(t("eventDetail.copied")),
          }}
        />
      )}

      {/* "Getting there" under the address (board option A). Renders
          nothing without areas: no heading, no legend. */}
      <GettingThereList areas={areas} selection={areaSelection} />

      {hasContact && (
        <div className={styles.contactSection}>
          <h3 className={styles.logisticsHeading}>{t("places.contact")}</h3>
          <ul className={styles.contactList}>
            {websiteHref && (
              <li>
                <a
                  href={websiteHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.contactRow}
                  aria-label={String(t("places.website"))}
                >
                  <Globe size={15} aria-hidden className={styles.contactIcon} />
                  <span className={styles.contactLabel}>
                    {displayHost(websiteHref)}
                  </span>
                  <ArrowUpRight size={13} aria-hidden />
                </a>
              </li>
            )}
            {telHref && phone && (
              <li>
                <a
                  href={telHref}
                  className={styles.contactRow}
                  aria-label={String(t("places.phone"))}
                >
                  <Phone size={15} aria-hidden className={styles.contactIcon} />
                  <span className={styles.contactLabel}>{phone}</span>
                </a>
              </li>
            )}
            {safeLinks.map((link, i) => (
              <li key={`${link.url}-${i}`}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.contactRow}
                >
                  <Link2
                    size={15}
                    aria-hidden
                    className={styles.contactIcon}
                  />
                  <span className={styles.contactLabel}>{link.label}</span>
                  <ArrowUpRight size={13} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
