import {
  buildItemListJsonLd,
  type ItemListItem,
} from "@th/types/seo/buildItemListJsonLd";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

export type EventListJsonLdProps = {
  items: ItemListItem[];
  /** BCP 47 language of the page; set on a page in a non-default language. */
  inLanguage?: string;
};

export function EventListJsonLd({ items, inLanguage }: EventListJsonLdProps) {
  const jsonLd = buildItemListJsonLd(items);
  if (!jsonLd) return null;

  return (
    <SeoJsonLd
      data={inLanguage ? { ...jsonLd, inLanguage } : jsonLd}
      id="event-list-jsonld"
    />
  );
}
