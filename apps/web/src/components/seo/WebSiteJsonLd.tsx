import { getSiteName, getSiteUrl, buildCanonicalUrl } from "@/config/site";
import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

/**
 * Renders a schema.org/WebSite JSON-LD block with a SearchAction.
 * This tells Google about the site-level search and enables a sitelinks
 * search box in SERPs.
 */
export function WebSiteJsonLd({ inLanguage }: { inLanguage?: string } = {}) {
  const siteUrl = getSiteUrl();
  const siteName = getSiteName();
  const searchUrl = buildCanonicalUrl("/search");

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    url: siteUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${searchUrl}?search={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
    ...(inLanguage ? { inLanguage } : {}),
  };

  return <SeoJsonLd data={data} id="website-jsonld" />;
}
