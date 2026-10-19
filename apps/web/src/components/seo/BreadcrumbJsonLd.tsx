import {
  buildBreadcrumbListJsonLd,
  type BreadcrumbListItem,
} from "@th/types/seo/buildBreadcrumbListJsonLd";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

export type BreadcrumbJsonLdProps = {
  items: BreadcrumbListItem[];
  /** BCP 47 language of the crumb names; set on a page in a non-default language. */
  inLanguage?: string;
};

/**
 * Emits a schema.org/BreadcrumbList `<script type="application/ld+json">` for a
 * page's crumb trail. The last item is the current page and should omit its
 * `url` (the pure builder drops the `item` field for the final crumb anyway).
 */
export function BreadcrumbJsonLd({ items, inLanguage }: BreadcrumbJsonLdProps) {
  if (items.length === 0) return null;
  const jsonLd = {
    ...buildBreadcrumbListJsonLd(items),
    ...(inLanguage ? { inLanguage } : {}),
  };
  return <SeoJsonLd data={jsonLd} id="breadcrumb-jsonld" />;
}
