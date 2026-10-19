import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { buildEntityPageMetadata } from "@th/types/seo/buildEntityPageMetadata";
import { getSiteName, buildCanonicalUrl } from "@/config/site";
import { loadEntityPageBySlug } from "@/server/entity-pages";
import {
  assertFeatureEnabled,
  getFeatureGatesServer,
} from "@/server/feature-gates";
import { EntityPageShell } from "@/app/p/[slug]/_components/EntityPageShell";
import { EntityPageJsonLd } from "@/app/p/[slug]/_components/EntityPageJsonLd";
import { toSeoEntityPage } from "@/app/p/[slug]/_components/to-seo-entity-page";

// Inert: the route is dynamic (the root layout awaits `headers()`/`cookies()`),
// so this caches nothing. The real cache is Cloudflare `s-maxage` from the
// header rules in next.config.ts.
export const revalidate = 60;

const getPage = cache(async (slug: string) => loadEntityPageBySlug(slug));

type HumanBySlugPageParams = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({
  params,
}: HumanBySlugPageParams): Promise<Metadata> {
  const { slug } = await params;

  // When the public-human-profiles gate is off, this route 404s (see the page
  // component's `assertFeatureEnabled`), so never advertise it — return
  // noindex/nofollow rather than a real title/canonical.
  const gates = await getFeatureGatesServer();
  if (!gates.humanProfilesPublic) {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }

  const result = await getPage(slug);

  if (!result) {
    return {
      title: "Person not found",
      robots: { index: false, follow: false },
    };
  }

  if (result.data.entity.type !== "HUMAN") {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = buildCanonicalUrl(`/humans/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return buildEntityPageMetadata({ page: seoPage, siteName: getSiteName() });
}

export default async function HumanBySlugPage({
  params,
}: HumanBySlugPageParams) {
  // This route is HUMAN-only, so gate the whole render: when public human
  // profiles are off, 404 before touching data. Org/place profiles live on
  // separate routes and are unaffected; the human's own admin/ownership
  // surfaces ride a different code path (`entityPages.getMyProfile`).
  await assertFeatureEnabled("humanProfilesPublic");

  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    notFound();
  }

  // Redirect if the slug was historical.
  if (result.redirect) {
    redirect(`/humans/${result.data.page.slug}`);
  }

  // Only HUMAN entities belong on this route; redirect others to /p/[slug].
  if (result.data.entity.type !== "HUMAN") {
    redirect(`/p/${slug}`);
  }

  const canonicalUrl = buildCanonicalUrl(`/humans/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return (
    <>
      <EntityPageJsonLd page={seoPage} />
      <EntityPageShell data={result.data} />
    </>
  );
}
