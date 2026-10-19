import type { SeoPlace } from "@th/types";
import { buildPlaceJsonLd } from "@th/types";
import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

interface PlaceJsonLdProps {
  place: SeoPlace;
}

/**
 * Render a schema.org/Place JSON-LD block for the given place.
 * Only renders when a place has a valid name.
 */
export function PlaceJsonLd({ place }: PlaceJsonLdProps) {
  if (!place.name) return null;
  const data = buildPlaceJsonLd(place);
  return <SeoJsonLd data={data} id="place-jsonld" />;
}
