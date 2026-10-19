import type { SeoPlace } from "./types";

export type PlaceJsonLd = Record<string, unknown>;

/**
 * Build a schema.org/Place JSON-LD object from an `SeoPlace` record.
 */
export const buildPlaceJsonLd = (place: SeoPlace): PlaceJsonLd => {
  const base: PlaceJsonLd = {
    "@context": "https://schema.org",
    "@type": "Place",
    name: place.name,
    url: place.url,
  };

  const hasAddress = Boolean(
    place.formattedAddress || place.city || place.region || place.countryCode,
  );

  if (hasAddress) {
    base.address = {
      "@type": "PostalAddress",
      ...(place.formattedAddress
        ? { streetAddress: place.formattedAddress }
        : {}),
      ...(place.city ? { addressLocality: place.city } : {}),
      ...(place.region ? { addressRegion: place.region } : {}),
      ...(place.countryCode ? { addressCountry: place.countryCode } : {}),
    };
  }

  if (typeof place.lat === "number" && typeof place.lng === "number") {
    if (place.isExact === false) {
      // Withheld venue: the coordinates are a deliberately-offset point (see
      // `redactPlaceLocation`), NOT the venue. Emitting sharp GeoCoordinates
      // would let crawlers index a precise pin at a wrong point and present it
      // as the address, so emit a schema.org GeoCircle instead (GeoCircle is a
      // GeoShape subtype; Place.geo accepts GeoCoordinates | GeoShape).
      // Fully-hidden venues carry no lat/lng at all and emit no `geo`.
      //
      // Mirrors the identical branch in `buildEventJsonLd`.
      base.geo = {
        "@type": "GeoCircle",
        geoMidpoint: {
          "@type": "GeoCoordinates",
          latitude: place.lat,
          longitude: place.lng,
        },
        ...(typeof place.radiusMeters === "number" &&
        Number.isFinite(place.radiusMeters)
          ? { geoRadius: place.radiusMeters }
          : {}),
      };
    } else {
      base.geo = {
        "@type": "GeoCoordinates",
        latitude: place.lat,
        longitude: place.lng,
      };
    }
  }

  if (typeof place.capacity === "number" && place.capacity > 0) {
    base.maximumAttendeeCapacity = place.capacity;
  }

  return base;
};
