"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import { useTranslations } from "@th/ui";

import { isMapEnabled } from "@/config/maps";
import { LocationMapPreview } from "@/components/maps/LocationMapPreview";
import { ArrivalAreasLegend } from "@/components/maps/ArrivalAreasLayer";
import {
  GettingThereList,
  useArrivalAreaSelection,
} from "@/components/maps/GettingThereList";
import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";
import { resolvePlaceLocationPrivacy } from "@/lib/places/location-privacy";
import { useViewerPlaceArrivalAreas } from "../use-viewer-place-arrival-areas";
import { useBlockPageOwner } from "./block-page-owner-context";
import { BlockSection, BlockHeading, BlockPillLink } from "./block-primitives";

/**
 * The `location_map` block's stored `data`.
 *
 * `isExact` / `hidden` / `radiusMeters` are written by the block builder from
 * the SAME `redactPlaceLocation` projection every other public read uses, so
 * `lat`/`lng` here is a true pin only when `isExact` is true; otherwise it is
 * the deliberately-offset circle centre, or absent.
 *
 * All three are OPTIONAL because this is a JSON bag on a row that predates
 * them. An old block carries none of them — which is exactly why every one of
 * them is read through the fail-closed resolver rather than directly.
 */
type LocationMapData = {
  heading?: string;
  lat?: number;
  lng?: number;
  address?: string;
  /** False = the venue withholds its address. ABSENT reads as withheld. */
  isExact?: boolean;
  /** True = fully hidden: no map at all. */
  hidden?: boolean;
  /** Circle radius in metres; non-null only in the obfuscated-circle state. */
  radiusMeters?: number | null;
  /**
   * Coarse area label. NOT currently emitted by the block derivation — it
   * folds the label into `address` instead (see `get-public-page.ts`:
   * `address: formattedAddress ?? areaLabel ?? "city, region"`). Read anyway,
   * so the day the producer starts sending it separately this file is already
   * right.
   */
  areaLabel?: string | null;
};

type Props = {
  block: PageBlockRecord;
};

const NO_AREAS: VisibleArrivalArea[] = [];

/**
 * The venue's location, on a freeform (block-canvas) entity page.
 *
 * The standard PLACE template suppresses this block and lets
 * `PlaceLogisticsCard` own location; this path is what a venue using the
 * freeform layout gets, so it has to honour the same three states.
 *
 * WHAT CHANGED (place-address-withholding): this used to render an address
 * paragraph plus an unconditional "View on map" link to Google Maps built from
 * whatever `lat`/`lng` or `address` the block happened to carry. For a withheld
 * venue that link is a directions affordance pointing at a point the venue
 * never published — so the link is now EXACT-ONLY, the circle state gets the
 * same dashed-circle map an obscured event gets, and the fully-hidden state
 * gets no map at all.
 */
export function LocationMapBlock({ block }: Props) {
  const place = useBlockPageOwner()?.place ?? null;
  // Arrival areas (arrival-areas FR-006) belong to the place that owns the
  // page; without a place owner the block renders exactly as before.
  if (!place) return <LocationMapBody block={block} areas={NO_AREAS} />;
  return (
    <PlaceLocationMapBlock
      block={block}
      placeId={place.id}
      publicAreas={place.arrivalAreas}
      publicPreview={place.publicPreview === true}
    />
  );
}

/**
 * The same arrival areas `PlaceLogisticsCard` shows on the standard template:
 * the server's anonymous list, replaced after hydration by the viewer's own
 * list from the no-store probe (skipped in the page editor).
 */
function PlaceLocationMapBlock({
  block,
  placeId,
  publicAreas,
  publicPreview,
}: Props & {
  placeId: string;
  publicAreas: VisibleArrivalArea[] | undefined;
  publicPreview: boolean;
}) {
  const viewerAreas = useViewerPlaceArrivalAreas(placeId, !publicPreview);
  return (
    <LocationMapBody
      block={block}
      areas={viewerAreas ?? publicAreas ?? NO_AREAS}
    />
  );
}

function LocationMapBody({
  block,
  areas,
}: Props & { areas: VisibleArrivalArea[] }) {
  const t = useTranslations();
  const areaSelection = useArrivalAreaSelection(areas);
  const data = block.data as LocationMapData | undefined;
  if (!data) return null;
  const hasAreas = areas.length > 0;

  const heading = data.heading ?? String(t("places.location"));
  const privacy = resolvePlaceLocationPrivacy({
    locationIsExact: data.isExact,
    locationHidden: data.hidden,
    locationRadiusMeters: data.radiusMeters,
    // `data.address` is the AREA LABEL — but ONLY when the producer positively
    // said `isExact: false`. In that branch `get-public-page` has already
    // written `formattedAddress ?? areaLabel ?? "city, region"` off an
    // already-redacted summary whose `formattedAddress` is null, so the string
    // is coarse by construction.
    //
    // `=== false`, never a fallthrough: a LEGACY block row carries an `address`
    // that IS a street address and no `isExact` at all. The resolver reads that
    // absence as withheld (correctly), and echoing `address` into the band
    // would then print the street under the word "AREA" — the exact leak this
    // component exists to close. An unlabelled band is the right answer there.
    areaLabel:
      data.areaLabel ?? (data.isExact === false ? data.address : null),
    lat: data.lat,
    lng: data.lng,
  });

  // Behind the EXACT branch on purpose: a withheld venue's block should not
  // carry an address at all, and if a stale one is still sitting in the JSON
  // bag this is what stops it reaching the page.
  const exact = privacy.kind === "exact" ? privacy : null;
  const address = exact ? data.address?.trim() || null : null;
  const exactPoint =
    exact?.lat != null && exact.lng != null
      ? { lat: exact.lat, lng: exact.lng }
      : null;

  // An exact venue with neither a point nor an address has no location to show
  // at all. The withheld states always have at least the band.
  if (exact && !exactPoint && !address && !hasAreas) return null;

  const mapsUrl = exactPoint
    ? `https://www.google.com/maps/search/?api=1&query=${exactPoint.lat},${exactPoint.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address ?? "")}`;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>

      {privacy.kind === "area" && (
        <div
          style={{ marginBottom: "0.75rem" }}
          data-testid="location-block-area-map"
        >
          <LocationMapPreview
            latitude={privacy.lat}
            longitude={privacy.lng}
            label={privacy.areaLabel}
            isExact={false}
            radiusMeters={privacy.radiusMeters}
            // The stored centre is ALREADY offset — jittering it again could
            // push the real venue outside its own circle.
            preObfuscated
            height={220}
            arrivalAreas={
              hasAreas
                ? {
                    areas,
                    selectedId: areaSelection.selectedId,
                    onSelect: areaSelection.selectFromMap,
                  }
                : undefined
            }
          />
          {hasAreas && isMapEnabled && <ArrivalAreasLegend areas={areas} />}
        </div>
      )}

      {/* EXACT with a point: the same pin map the standard template's
          logistics card draws, carrying the arrival areas. Only this branch
          ever gets a pin; `exactPoint` is null for every withheld state.
          With tiles off it keeps the address and maps link alone, rather
          than drawing a "map unavailable" box. */}
      {exactPoint && isMapEnabled && (
        <div
          style={{ marginBottom: "0.75rem" }}
          data-testid="location-block-exact-map"
        >
          <LocationMapPreview
            latitude={exactPoint.lat}
            longitude={exactPoint.lng}
            label={address ?? heading}
            height={220}
            arrivalAreas={
              hasAreas
                ? {
                    areas,
                    selectedId: areaSelection.selectedId,
                    onSelect: areaSelection.selectFromMap,
                  }
                : undefined
            }
          />
          {hasAreas && <ArrivalAreasLegend areas={areas} />}
        </div>
      )}

      {address && (
        <p
          style={{
            marginBottom: "0.5rem",
            opacity: 0.8,
            fontSize: "0.9375rem",
          }}
        >
          {address}
        </p>
      )}

      {privacy.kind !== "exact" && (
        <div data-testid="location-block-area-band">
          <p
            style={{
              margin: 0,
              fontSize: "1.125rem",
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "-0.01em",
              overflowWrap: "anywhere",
            }}
          >
            {privacy.areaLabel ?? String(t("places.locationAreaUnknown"))}
          </p>
          <p style={{ margin: "0.375rem 0 0", opacity: 0.8, fontSize: "0.875rem" }}>
            {privacy.kind === "area"
              ? String(t("places.locationApproxBody"))
              : String(t("places.locationWithheldBody"))}
          </p>
          <p style={{ margin: "0.25rem 0 0", opacity: 0.8, fontSize: "0.875rem" }}>
            {String(t("places.locationWithheldWhere"))}
          </p>
        </div>
      )}

      {/* EXACT ONLY. A maps link for a withheld venue is a directions
          affordance wearing a different hat. */}
      {exact && (exactPoint || address) && (
        <BlockPillLink href={mapsUrl} external>
          {String(t("eventDetail.viewOnMap"))} &#8599;
        </BlockPillLink>
      )}

      {/* "Getting there": the keyboard twin of the map, and the only place
          the areas show when a place has no map (fully hidden, or an exact
          place with an address but no point). Renders nothing without areas. */}
      <GettingThereList areas={areas} selection={areaSelection} />
    </BlockSection>
  );
}
