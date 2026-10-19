import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import type { SeoPlace } from "@th/types";
import { buildPlaceMetadata } from "@th/types";
import { buildCanonicalUrl, getSiteName } from "@/config/site";
import {
  loadPlaceEvents,
  loadPlacePublic,
  resolvePlaceById,
} from "@/server/places";
import { PlaceJsonLd } from "@/components/seo/PlaceJsonLd";
import { PlaceContent } from "./PlaceContent";

export const revalidate = 60;

const getPlace = cache(async (placeId: string) => loadPlacePublic(placeId));

type PlaceByIdPageParams = {
  params: Promise<{
    placeId: string;
  }>;
};

function toSeoPlace(
  place: {
    placeId: string;
    name: string;
    formattedAddress?: string | null;
    city?: string | null;
    region?: string | null;
    countryCode?: string | null;
    lat?: number | null;
    lng?: number | null;
    capacity?: number | null;
    /** From `getPlacePublic` — already redacted; see `redactPlaceLocation`. */
    locationIsExact?: boolean;
    locationRadiusMeters?: number | null;
  },
  canonicalUrl: string,
): SeoPlace {
  return {
    placeId: place.placeId,
    url: canonicalUrl,
    name: place.name,
    formattedAddress: place.formattedAddress,
    city: place.city,
    region: place.region,
    countryCode: place.countryCode,
    lat: place.lat,
    lng: place.lng,
    // ADDRESS PRIVACY (place-address-withholding). Without these two,
    // `buildPlaceJsonLd` falls back to its "assume exact" default and emits
    // sharp `GeoCoordinates` for what is actually a deliberately-offset circle
    // centre — machine-readable markup asserting a precise pin at a point the
    // venue never published. Passing them selects the `GeoCircle` branch.
    //
    // `=== true`, not a truthiness coercion: an absent flag must not read as
    // exact. Fully-hidden venues arrive with null coordinates and emit no
    // `geo` at all either way.
    isExact: place.locationIsExact === true,
    radiusMeters: place.locationRadiusMeters ?? null,
    capacity: place.capacity,
  };
}

export async function generateMetadata({
  params,
}: PlaceByIdPageParams): Promise<Metadata> {
  const { placeId } = await params;

  // Future-proofing: if resolvePlaceById ever canonicalizes IDs, keep metadata stable.
  const resolution = await resolvePlaceById(placeId);
  const canonicalPlaceId = resolution ? resolution.placeId : placeId;

  const payload = await getPlace(canonicalPlaceId);
  if (!payload) {
    return {
      title: "Place not found",
      description: "The requested place could not be located.",
      robots: { index: false, follow: false },
    } satisfies Metadata;
  }

  const place = payload.place;
  // FR-011: only VERIFIED venues are indexable. Unverified/stub pages still
  // render (so a direct share link works) but must emit robots noindex —
  // closing the consent gap where anonymous-review-created stubs were
  // crawlable. `status === "ACTIVE"` alone was too permissive.
  const shouldIndex =
    place.status === "ACTIVE" && place.verificationStatus === "VERIFIED";
  const canonicalUrl = buildCanonicalUrl(`/places/id/${canonicalPlaceId}`);
  const siteName = getSiteName();

  const seoPlace = toSeoPlace(place, canonicalUrl);

  return buildPlaceMetadata({ place: seoPlace, siteName, shouldIndex });
}

export default async function PlaceByIdPage({ params }: PlaceByIdPageParams) {
  const { placeId } = await params;

  const resolution = await resolvePlaceById(placeId);
  const canonicalPlaceId = resolution?.placeId ?? placeId;

  const payload = await getPlace(canonicalPlaceId);
  if (!payload) {
    notFound();
  }

  const { place } = payload;

  const canonicalUrl = buildCanonicalUrl(`/places/id/${canonicalPlaceId}`);
  const seoPlace = toSeoPlace(place, canonicalUrl);

  const eventsPayload = await loadPlaceEvents({
    placeId: canonicalPlaceId,
    status: "upcoming",
    // Default: show a 2y window around now.
    from: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365),
    to: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 2),
    limit: 25,
    offset: 0,
  });

  // listPlaceEvents also enforces place visibility (404 for ARCHIVED/missing).
  if (!eventsPayload) {
    notFound();
  }

  const upcomingEvents = eventsPayload.events;

  // Serialize dates to strings for the client component
  const serializedEvents = upcomingEvents.map((event) => ({
    eventId: event.eventId,
    title: event.title,
    slug: event.slug ?? null,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
  }));

  return (
    <>
      {place.status === "ACTIVE" && place.verificationStatus === "VERIFIED" ? (
        <PlaceJsonLd place={seoPlace} />
      ) : null}
      <PlaceContent
        placeId={canonicalPlaceId}
        place={place}
        upcomingEvents={serializedEvents}
      />
    </>
  );
}
