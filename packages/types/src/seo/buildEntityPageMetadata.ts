import type { Metadata } from "next";
import type { SeoEntityPage } from "./entity-page-types";

export interface BuildEntityPageMetadataInput {
  page: SeoEntityPage;
  siteName: string;
  /** Whether search engines should index this page. Defaults to `true`. */
  shouldIndex?: boolean;
}

/**
 * Build Next.js `Metadata` for an entity page — canonical URL, OG, Twitter, robots.
 * Pure function, no side effects. Mirrors the pattern of `buildEventMetadata`.
 */
export const buildEntityPageMetadata = ({
  page,
  siteName,
  shouldIndex = true,
}: BuildEntityPageMetadataInput): Metadata => {
  const title = page.displayName;
  const description = page.bio ?? `${page.displayName} on ${siteName}`;

  const images =
    page.avatarUrl || page.bannerUrl
      ? [{ url: (page.bannerUrl ?? page.avatarUrl)!, alt: page.displayName }]
      : [];

  return {
    title,
    description,
    alternates: { canonical: page.url },
    robots: { index: shouldIndex, follow: shouldIndex },
    openGraph: {
      type: "website",
      url: page.url,
      title,
      description,
      siteName,
      ...(images.length > 0 ? { images } : {}),
    },
    twitter: {
      card: images.length > 0 ? "summary_large_image" : "summary",
      title,
      description,
      ...(images.length > 0 ? { images } : {}),
    },
  } satisfies Metadata;
};
