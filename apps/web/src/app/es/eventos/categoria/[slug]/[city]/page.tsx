import type { Metadata } from "next";

import {
  GeoCategoryRouteBody,
  geoCategoryMetadata,
} from "@/app/events/category/[slug]/[city]/_lib/geo-category-route";

// Spanish twin of `/events/category/[slug]/[city]` (spanish-seo FR-001, R21):
// the same loader and components, with the locale from the URL.

// Same as the English twin, and as inert (the route is dynamic); see the
// note there. Its edge cache is the `/es/eventos/:path*` rule in
// next.config.ts.
export const revalidate = 3600;

type GeoCategoryPageProps = {
  params: Promise<{ slug: string; city: string }>;
};

export async function generateMetadata({
  params,
}: GeoCategoryPageProps): Promise<Metadata> {
  const { slug, city } = await params;
  return geoCategoryMetadata("es", slug, city);
}

export default async function SpanishGeoCategoryRoute({
  params,
}: GeoCategoryPageProps) {
  const { slug, city } = await params;
  return GeoCategoryRouteBody({ locale: "es", slug, city });
}
