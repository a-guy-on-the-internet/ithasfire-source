import type { Metadata } from "next";

import {
  GeoCategoryRouteBody,
  geoCategoryMetadata,
} from "./_lib/geo-category-route";

// The page itself lives in `_lib/geo-category-route.tsx`, shared with its
// Spanish twin `/es/eventos/categoria/[slug]/[city]` (spanish-seo R21).

// Inert: this route is dynamic and renders on every request. The root layout
// awaits `headers()`/`cookies()`, and every SSR tRPC client signs the
// visitor's IP from `headers()` and fetches with `cache: "no-store"`
// (server/trpc-client.ts); any one of them opts the route into dynamic
// rendering, so `revalidate` caches nothing. The real cache is Cloudflare
// `s-maxage` from the `/events/:path(...)` header rule in next.config.ts. Kept in case
// those reads stop being dynamic. The Spanish twin keeps the same setting.
export const revalidate = 3600;

type GeoCategoryPageProps = {
  params: Promise<{ slug: string; city: string }>;
};

export async function generateMetadata({
  params,
}: GeoCategoryPageProps): Promise<Metadata> {
  const { slug, city } = await params;
  return geoCategoryMetadata("en", slug, city);
}

export default async function GeoCategoryRoute({
  params,
}: GeoCategoryPageProps) {
  const { slug, city } = await params;
  return GeoCategoryRouteBody({ locale: "en", slug, city });
}
