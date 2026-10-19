/**
 * Builds a schema.org/ItemList JSON-LD object for event listing pages.
 *
 * Used on homepage, search results, and category pages to help search engines
 * understand the list of events displayed.
 */
export interface ItemListItem {
  url: string;
  name: string;
}

export function buildItemListJsonLd(
  items: ItemListItem[],
): Record<string, unknown> | null {
  if (items.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: item.url,
      name: item.name,
    })),
  };
}
