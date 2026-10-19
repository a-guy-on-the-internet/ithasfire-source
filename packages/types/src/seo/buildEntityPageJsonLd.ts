import type { SeoEntityPage } from "./entity-page-types";

export type EntityPageJsonLd = Record<string, unknown>;

/**
 * Build a schema.org JSON-LD object for an entity page.
 *
 * - HUMAN  → schema.org/Person (or MusicGroup if we later detect performer status)
 * - PLACE  → schema.org/Place
 * - ORGANIZATION → schema.org/Organization
 */
export const buildEntityPageJsonLd = (
  page: SeoEntityPage,
): EntityPageJsonLd => {
  switch (page.ownerType) {
    case "HUMAN":
      return buildPersonJsonLd(page);
    case "PLACE":
      return buildPlacePageJsonLd(page);
    case "ORGANIZATION":
      return buildOrganizationJsonLd(page);
    default:
      return buildPersonJsonLd(page);
  }
};

function buildPersonJsonLd(page: SeoEntityPage): EntityPageJsonLd {
  const ld: EntityPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: page.displayName,
    url: page.url,
  };

  if (page.bio) ld.description = page.bio;
  if (page.avatarUrl) ld.image = page.avatarUrl;

  return ld;
}

function buildPlacePageJsonLd(page: SeoEntityPage): EntityPageJsonLd {
  const ld: EntityPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "Place",
    name: page.displayName,
    url: page.url,
  };

  if (page.bio) ld.description = page.bio;
  if (page.avatarUrl) ld.image = page.avatarUrl;

  const entity = page.entity;
  if (entity.type === "PLACE") {
    const hasAddress = Boolean(entity.city || entity.region);
    if (hasAddress) {
      ld.address = {
        "@type": "PostalAddress",
        ...(entity.city ? { addressLocality: entity.city } : {}),
        ...(entity.region ? { addressRegion: entity.region } : {}),
      };
    }
    if (typeof entity.lat === "number" && typeof entity.lng === "number") {
      // ADDRESS PRIVACY (place-address-withholding). `entity` is already
      // redacted by `loadEntitySummary`, so a withheld venue's coordinates are
      // the deliberately-offset circle CENTRE, not the venue — and a
      // fully-hidden one has none at all. Emitting sharp `GeoCoordinates` for
      // an offset point would publish, in machine-readable markup, a precise
      // assertion about where a venue is that is both wrong and unauthorised.
      //
      // `!== true`, not `=== false`: the flag is optional on `EntitySummary`
      // (client-side fallback summaries omit it), and an absent flag must read
      // as withheld. The cost of getting this backwards is asymmetric.
      //
      // Mirrors the identical branch in `buildPlaceJsonLd` / `buildEventJsonLd`.
      if (entity.locationIsExact !== true) {
        ld.geo = {
          "@type": "GeoCircle",
          geoMidpoint: {
            "@type": "GeoCoordinates",
            latitude: entity.lat,
            longitude: entity.lng,
          },
          ...(typeof entity.locationRadiusMeters === "number" &&
          Number.isFinite(entity.locationRadiusMeters)
            ? { geoRadius: entity.locationRadiusMeters }
            : {}),
        };
      } else {
        ld.geo = {
          "@type": "GeoCoordinates",
          latitude: entity.lat,
          longitude: entity.lng,
        };
      }
    }
  }

  return ld;
}

function buildOrganizationJsonLd(page: SeoEntityPage): EntityPageJsonLd {
  const ld: EntityPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: page.displayName,
    url: page.url,
  };

  if (page.bio) ld.description = page.bio;
  if (page.avatarUrl) ld.logo = page.avatarUrl;

  return ld;
}
