import { buildFaqJsonLd, type FaqEntry } from "@th/types/seo/buildFaqJsonLd";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

export type FaqJsonLdProps = {
  entries: FaqEntry[];
  id?: string;
};

export function FaqJsonLd({ entries, id = "faq-jsonld" }: FaqJsonLdProps) {
  const jsonLd = buildFaqJsonLd(entries);
  if (!jsonLd) return null;

  return <SeoJsonLd data={jsonLd} id={id} />;
}
