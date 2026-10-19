import type { Metadata } from "next";

import { CategoryRouteBody, categoryMetadata } from "./_lib/category-route";

// The page itself lives in `_lib/category-route.tsx`, shared with its Spanish
// twin `/es/eventos/categoria/[slug]` (spanish-seo R21).

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  return categoryMetadata("en", slug);
}

// Dynamic, not ISR (`revalidate`): the page reads no search params, but every
// SSR tRPC client signs the visitor's IP from `headers()` and fetches with
// `cache: "no-store"` (server/trpc-client.ts), and either one opts the route
// into dynamic rendering. A `revalidate` here would read as caching it does not
// do. The Spanish twin keeps the same setting.
export const dynamic = "force-dynamic";

export default async function CategoryRoute({ params }: CategoryPageProps) {
  const { slug } = await params;
  return CategoryRouteBody({ locale: "en", slug });
}
