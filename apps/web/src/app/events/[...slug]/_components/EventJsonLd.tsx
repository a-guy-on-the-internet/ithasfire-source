import type { SeoEvent } from "@th/types/seo/types";
import { buildEventJsonLd } from "@th/types/seo/buildEventJsonLd";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";
import {
  applyEventJsonLdEnrichment,
  type EventJsonLdEnrichment,
} from "@/lib/seo/event-json-ld-enrichment";

export type EventJsonLdProps = {
  event: SeoEvent;
  /**
   * Organizer and posterless-image additions built on the server (they need
   * the site URL). Applied to the JSON-LD only, never to `event` itself.
   */
  enrichment?: EventJsonLdEnrichment | null;
  id?: string;
  nonce?: string;
};

export function EventJsonLd({ event, enrichment, id, nonce }: EventJsonLdProps) {
  // Only emit structured data for indexable events.
  // This avoids search engines picking up draft/cancelled/etc events if they ever become reachable.
  if (event.status !== "PUBLISHED") {
    return null;
  }

  const jsonLd = buildEventJsonLd(applyEventJsonLdEnrichment(event, enrichment));

  return <SeoJsonLd data={jsonLd} id={id ?? "event-jsonld"} nonce={nonce} />;
}
