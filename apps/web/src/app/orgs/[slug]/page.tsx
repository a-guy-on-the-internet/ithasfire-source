import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { buildEntityPageMetadata } from "@th/types/seo/buildEntityPageMetadata";
import { getSiteName, buildCanonicalUrl } from "@/config/site";
import { loadEntityPageBySlug } from "@/server/entity-pages";
import { EntityPageShell } from "@/app/p/[slug]/_components/EntityPageShell";
import { EntityPageJsonLd } from "@/app/p/[slug]/_components/EntityPageJsonLd";
import { toSeoEntityPage } from "@/app/p/[slug]/_components/to-seo-entity-page";

// Inert: the route is dynamic (the root layout awaits `headers()`/`cookies()`),
// so this caches nothing. The real cache is Cloudflare `s-maxage` from the
// header rules in next.config.ts.
export const revalidate = 60;

const getPage = cache(async (slug: string) => loadEntityPageBySlug(slug));

type OrgBySlugPageParams = {
  params: Promise<{
    slug: string;
  }>;
};

export async function generateMetadata({
  params,
}: OrgBySlugPageParams): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    return {
      title: "Group not found",
      robots: { index: false, follow: false },
    };
  }

  if (result.data.entity.type !== "ORGANIZATION") {
    return {
      title: "Page not found",
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = buildCanonicalUrl(`/orgs/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return buildEntityPageMetadata({ page: seoPage, siteName: getSiteName() });
}

export default async function OrgBySlugPage({ params }: OrgBySlugPageParams) {
  const { slug } = await params;
  const result = await getPage(slug);

  if (!result) {
    notFound();
  }

  // Redirect if the slug was historical.
  if (result.redirect) {
    redirect(`/orgs/${result.data.page.slug}`);
  }

  // Only ORGANIZATION entities belong on this route; redirect others to /p/[slug].
  if (result.data.entity.type !== "ORGANIZATION") {
    redirect(`/p/${slug}`);
  }

  const canonicalUrl = buildCanonicalUrl(`/orgs/${result.data.page.slug}`);
  const seoPage = toSeoEntityPage(result.data, canonicalUrl);

  return (
    <>
      <EntityPageJsonLd page={seoPage} />
      <EntityPageShell data={result.data} />
    </>
  );
}
