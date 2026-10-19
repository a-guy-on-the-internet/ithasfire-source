import type { Metadata } from "next";
import type { SeoPlace } from "./types";

export interface BuildPlaceMetadataInput {
  place: SeoPlace;
  siteName: string;
  shouldIndex?: boolean;
}

/**
 * Build Next.js `Metadata` for a place page, including canonical, OG, and Twitter.
 */
export const buildPlaceMetadata = ({
  place,
  siteName,
  shouldIndex = true,
}: BuildPlaceMetadataInput): Metadata => {
  const descriptionParts = [place.city, place.region, place.countryCode].filter(
    (v): v is string => Boolean(v?.trim().length),
  );
  const description = descriptionParts.length
    ? `Events at ${place.name} — ${descriptionParts.join(", ")}`
    : `Events at ${place.name}`;

  const title = place.name;

  return {
    title,
    description,
    alternates: { canonical: place.url },
    robots: { index: shouldIndex, follow: shouldIndex },
    openGraph: {
      type: "website",
      url: place.url,
      title,
      description,
      siteName,
    },
    twitter: {
      card: "summary",
      title,
      description,
    },
  };
};
