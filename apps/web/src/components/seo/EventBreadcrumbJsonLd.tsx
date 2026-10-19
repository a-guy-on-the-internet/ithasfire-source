import { buildEventBreadcrumbJsonLd } from "@th/types/seo/buildEventBreadcrumbJsonLd";

import { getSiteName, getSiteUrl } from "@/config/site";
import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

export type EventBreadcrumbJsonLdProps = {
  eventName: string;
};

/** Home › Events › Event title. See `buildEventBreadcrumbJsonLd`. */
export function EventBreadcrumbJsonLd({ eventName }: EventBreadcrumbJsonLdProps) {
  if (!eventName) return null;

  const jsonLd = buildEventBreadcrumbJsonLd({
    eventName,
    siteUrl: getSiteUrl(),
    siteName: getSiteName(),
  });

  return <SeoJsonLd data={jsonLd} id="event-breadcrumb-jsonld" />;
}
