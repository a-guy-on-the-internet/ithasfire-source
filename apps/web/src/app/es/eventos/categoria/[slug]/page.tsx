import type { Metadata } from "next";

import {
  CategoryRouteBody,
  categoryMetadata,
} from "@/app/events/category/[slug]/_lib/category-route";

// Spanish twin of `/events/category/[slug]` (spanish-seo FR-001, R21): the
// same loader and components, with the locale from the URL.

type CategoryPageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  return categoryMetadata("es", slug);
}

// Same as the English twin; see the note there.
export const dynamic = "force-dynamic";

export default async function SpanishCategoryRoute({
  params,
}: CategoryPageProps) {
  const { slug } = await params;
  return CategoryRouteBody({ locale: "es", slug });
}
