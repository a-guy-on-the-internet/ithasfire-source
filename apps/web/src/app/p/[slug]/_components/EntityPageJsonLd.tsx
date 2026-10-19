import type { SeoEntityPage } from "@th/types/seo/entity-page-types";
import { buildEntityPageJsonLd } from "@th/types/seo/buildEntityPageJsonLd";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

export type EntityPageJsonLdProps = {
  page: SeoEntityPage;
  id?: string;
  nonce?: string;
};

export function EntityPageJsonLd({ page, id, nonce }: EntityPageJsonLdProps) {
  const jsonLd = buildEntityPageJsonLd(page);

  return (
    <SeoJsonLd data={jsonLd} id={id ?? "entity-page-jsonld"} nonce={nonce} />
  );
}
