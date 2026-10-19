import type { Metadata } from "next";

import {
  pickHeroImageUrl,
  resolveEventOgImage,
  type EventOgImageInput,
  type ResolvedEventOgImage,
} from "@th/types/seo/eventOgImage";

import type { SeoEvent } from "@th/types/seo/types";

import { getSiteUrl } from "@/config/site";

/** The fields of an event's SEO payload the generated Date Stub is built from. */
export type EventOgImageSource = Pick<
  SeoEvent,
  "id" | "name" | "startsAt" | "timezone" | "updatedAt" | "images" | "location"
>;

/**
 * THE `EventOgImageInput` for an event page: `generateMetadata` (the
 * `og:image` / `twitter:image` meta) and the JSON-LD `image` fallback both
 * build it here, so the two always name the same stub URL.
 *
 * `canonicalSlug` is passed separately because the page renders against the
 * resolved canonical slug, which is the stub's routing key.
 */
export const eventOgImageInputFor = (
  event: EventOgImageSource,
  canonicalSlug: string,
): EventOgImageInput => ({
  id: event.id,
  slug: canonicalSlug,
  title: event.name,
  startsAt: event.startsAt,
  timezone: event.timezone,
  updatedAt: event.updatedAt,
  images: event.images,
  venueName: event.location?.name ?? null,
  // The stub's place line composes "Place · City, ST", degrading to
  // "City, ST" when the place is not publicly named — see
  // `eventStubVenueLine`. All three are rendered inputs, so all three must
  // reach the SIGNATURE too or the page's `?v=` would never match the one the
  // route computes.
  city: event.location?.city ?? null,
  region: event.location?.region ?? null,
});

/**
 * The `apps/web` binding of the shared OG-image resolver.
 *
 * The pure logic lives in `@th/types/seo/eventOgImage` so `@th/core`'s email
 * renderers can reach the same answer; this module is the thin layer that
 * supplies THIS app's site URL. `packages/types` must not learn about
 * `apps/web` URLs, so the base always travels as an argument.
 */
export const resolveEventOgImageForSite = (
  event: EventOgImageInput,
): ResolvedEventOgImage => resolveEventOgImage(event, getSiteUrl());

/**
 * Substitutes the generated Date Stub into a `Metadata` object when the event
 * has no hero image of its own.
 *
 * Applied AFTER `buildEventMetadata` rather than inside it: the shared builder
 * reports the event's images as facts (`event:image`, `event:images`), and a
 * synthetic stub is not one of the event's images — it is what a SHARE SURFACE
 * should show in the absence of one. Keeping the substitution here also keeps
 * `@th/types` free of any knowledge of this app's routes.
 *
 * Also upgrades the Twitter card to `summary_large_image`: with a real
 * 1200x630 artifact there is now always a large image to show, where before an
 * image-less event fell back to the small `summary` card.
 */
export const withGeneratedEventOgImage = (
  metadata: Metadata,
  event: EventOgImageInput,
): Metadata => {
  // The event already has a poster — `buildEventMetadata` used it; nothing to
  // do. (The resolver would return the same URL, but skipping is cheaper and
  // leaves the existing `alt` handling untouched.)
  if (pickHeroImageUrl(event.images)) return metadata;

  const resolved = resolveEventOgImageForSite(event);
  const images = [{ url: resolved.url, alt: event.title }];

  return {
    ...metadata,
    openGraph: { ...(metadata.openGraph ?? {}), images },
    twitter: {
      ...(metadata.twitter ?? {}),
      card: "summary_large_image",
      images,
    },
  };
};
