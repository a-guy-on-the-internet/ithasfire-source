import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { buildEntityPageMetadata } from "@th/types/seo/buildEntityPageMetadata";
import { getSiteName, buildCanonicalUrl } from "@/config/site";
import { loadEntityPageBySlug } from "@/server/entity-pages";
import { loadPublicPlaceArrivalAreas } from "@/server/arrival-areas";
import { loadPublicMembershipTiers } from "@/server/membership-tiers";
import { getFeatureGatesServer } from "@/server/feature-gates";
import { EntityPageShell } from "./_components/EntityPageShell";
import { EntityPageJsonLd } from "./_components/EntityPageJsonLd";
import { toSeoEntityPage } from "./_components/to-seo-entity-page";

/**
 * DECLARED, BUT CURRENTLY INERT — see the identical note on
 * `app/places/[slug]/page.tsx`, which this route shares a loader (and therefore
 * a `headers()`-driven dynamic render) with. Measured on a production build:
 * this page reflects a `Place.acceptsBookingRequests` change on the very next
 * request, so the 60s window this line implies does not exist. The real
 * staleness is Cloudflare's edge cache of the `s-maxage=120` response.
 */
export const revalidate = 60;

const getPage = cache(async (slug: string) => loadEntityPageBySlug(slug));

type PageParams = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }

  // HUMAN entities are hidden behind the `humanProfilesPublic` gate; when it's
  // off the page component 404s, so don't advertise the route. ORG/PLACE
  // profiles stay fully public and are never affected.
  if (result.data.entity.type === "HUMAN") {
    const gates = await getFeatureGatesServer();
    if (!gates.humanProfilesPublic) {
      return {
        title: "Page not found",
        robots: { index: false, follow: false },
      };
    }
  }

  const canonicalUrl = buildCanonicalUrl(`/p/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return buildEntityPageMetadata({ page: seoPage, siteName: getSiteName() });
}

export default async function EntityPublicPage({ params }: PageParams) {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    notFound();
  }

  // Redirect if the slug was historical.
  if (result.redirect) {
    redirect(`/p/${result.data.page.slug}`);
  }

  // Conditional gate: only HUMAN entities are hidden behind
  // `humanProfilesPublic`. ORG/PLACE renders are never gated. The human's own
  // admin/ownership surfaces live on a different route + code path, so this
  // only hides the PUBLIC render.
  if (result.data.entity.type === "HUMAN") {
    const gates = await getFeatureGatesServer();
    if (!gates.humanProfilesPublic) {
      notFound();
    }
  }

  const canonicalUrl = buildCanonicalUrl(`/p/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  // Membership tab data — HUMAN/ORG owners only (PLACEs cannot own tiers).
  // Empty (no tiers, suspended owner, or memberships unavailable) ⇒ no tab.
  const entityType = result.data.entity.type;
  const membershipTiers =
    entityType === "HUMAN" || entityType === "ORGANIZATION"
      ? await loadPublicMembershipTiers(entityType, result.data.entity.id)
      : [];

  // PLACE only: the anonymous, cache-safe arrival areas (see /places/[slug]).
  const arrivalAreas =
    entityType === "PLACE"
      ? await loadPublicPlaceArrivalAreas(result.data.entity.id)
      : [];

  return (
    <>
      <EntityPageJsonLd page={seoPage} />
      <EntityPageShell
        data={{ ...result.data, arrivalAreas }}
        membershipTiers={membershipTiers}
      />
    </>
  );
}
