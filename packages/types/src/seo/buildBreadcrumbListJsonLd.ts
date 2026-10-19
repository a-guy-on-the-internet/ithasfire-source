/**
 * Generic schema.org/BreadcrumbList JSON-LD builder.
 *
 * Google requires `item` (the crumb's URL) on every `ListItem` except the
 * last, and Search Console reports a list that breaks that as a CRITICAL
 * error, which drops the whole breadcrumb from rich results. So:
 *
 *   - a NON-LAST crumb with no `url` is DROPPED, and positions renumber 1..n
 *     over what remains (no caller can emit an item-less middle crumb);
 *   - the LAST crumb always omits `item`, even when a url is given (the final
 *     crumb is the current page).
 */
export interface BreadcrumbListItem {
  name: string;
  url?: string;
}

export function buildBreadcrumbListJsonLd(
  items: BreadcrumbListItem[],
): Record<string, unknown> {
  const lastIndex = items.length - 1;
  const kept = items.filter(
    (item, index) => index === lastIndex || Boolean(item.url),
  );
  const keptLastIndex = kept.length - 1;

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: kept.map((item, index) => {
      const element: Record<string, unknown> = {
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
      };
      if (item.url && index !== keptLastIndex) {
        element.item = item.url;
      }
      return element;
    }),
  };
}
