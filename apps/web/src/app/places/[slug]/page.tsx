import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { cache } from "react";

import { buildEntityPageMetadata } from "@th/types/seo/buildEntityPageMetadata";
import { getSiteName, buildCanonicalUrl } from "@/config/site";
import { loadEntityPageBySlug } from "@/server/entity-pages";
import { loadPublicPlaceArrivalAreas } from "@/server/arrival-areas";
import { EntityPageShell } from "@/app/p/[slug]/_components/EntityPageShell";
import { EntityPageJsonLd } from "@/app/p/[slug]/_components/EntityPageJsonLd";
import { toSeoEntityPage } from "@/app/p/[slug]/_components/to-seo-entity-page";

/**
 * DECLARED, BUT CURRENTLY INERT — do not reason from this number.
 *
 * This route builds as `ƒ` (Dynamic, server-rendered on demand): `loadEntityPageBySlug`
 * goes through the SSR tRPC client, whose `httpBatchLink` header callback awaits
 * `headers()`, and that dynamic API opts the whole render out of the route cache.
 * Measured against a real `next build --turbopack` + `next start`: changing
 * `Place.acceptsBookingRequests` in Postgres changed the rendered CTA on the very
 * next request, in both directions, with nothing revalidated. So the 60s window a
 * reader would infer from this line does not exist.
 *
 * Left in place because the intent (a cacheable public page) is right and the
 * blocker is incidental. If you make it real, keep
 * `app/api/places/[placeId]/revalidate/route.ts` — that purge is what stops a
 * venue's booking switch from silently taking a minute to reach visitors.
 *
 * The staleness readers actually hit is the EDGE, not this: `next.config.ts`
 * sends `s-maxage=120, stale-while-revalidate=300` for `/places/:path*` and
 * Cloudflare caches HTML with `respect_origin`.
 */
export const revalidate = 60;

const getPage = cache(async (slug: string) => loadEntityPageBySlug(slug));

type PlaceBySlugPageParams = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({
  params,
}: PlaceBySlugPageParams): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    return {
      title: "Place not found",
      robots: { index: false, follow: false },
    };
  }

  // If the entity isn't a place, don't serve it here.
  if (result.data.entity.type !== "PLACE") {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = buildCanonicalUrl(`/places/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return buildEntityPageMetadata({ page: seoPage, siteName: getSiteName() });
}

export default async function PlaceBySlugPage({
  params,
}: PlaceBySlugPageParams) {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    notFound();
  }

  // Only PLACE entities belong on this route; send others to their current
  // /p/[slug] page. Checked before the 308 so a permanent hop never targets
  // a /places URL that would itself redirect.
  if (result.data.entity.type !== "PLACE") {
    redirect(`/p/${result.data.page.slug}`);
  }

  // Owner 2026-10-16: an old place URL is permanent; 308 moves its ranking.
  if (result.redirect) {
    permanentRedirect(`/places/${result.data.page.slug}`);
  }

  const canonicalUrl = buildCanonicalUrl(`/places/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  // Arrival areas: the ANONYMOUS read only (`getPublicTrpcClient`), kept when
  // the API marks it `cacheablePublic`, because this document is edge-cached.
  // Never in the JSON-LD or metadata above (NFR-002).
  const arrivalAreas = await loadPublicPlaceArrivalAreas(result.data.entity.id);

  return (
    <>
      <EntityPageJsonLd page={seoPage} />
      <EntityPageShell data={{ ...result.data, arrivalAreas }} />
    </>
  );
}
