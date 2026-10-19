import { buildBreadcrumbListJsonLd } from "./buildBreadcrumbListJsonLd";

/**
 * Builds the schema.org/BreadcrumbList JSON-LD for a public event page:
 *
 *   Home › Events › Event title
 *
 * Every crumb but the last links somewhere (Google requires `item` on each
 * non-last crumb). The country and region the event slug carries
 * (`{host}/{country}/{region}/{title-date--shortId}`) are NOT crumbs: no page
 * lists events by country or region, so they had no URL to give, and their
 * text-only crumbs were the "Missing field item" errors Search Console
 * reported. Add them back only together with a page each one links to.
 */
export interface BreadcrumbJsonLdInput {
  /** Human-readable event title */
  eventName: string;
  /** Site root URL, e.g. "https://ithasfire.com" */
  siteUrl: string;
  /** Site display name, e.g. "Ithas Fire" */
  siteName: string;
}

export function buildEventBreadcrumbJsonLd(
  input: BreadcrumbJsonLdInput,
): Record<string, unknown> {
  const { eventName, siteUrl, siteName } = input;

  return buildBreadcrumbListJsonLd([
    { name: siteName, url: siteUrl },
    { name: "Events", url: `${siteUrl}/search` },
    // The current page: no `item` URL, per Google's guidance for the last crumb.
    { name: eventName },
  ]);
}
