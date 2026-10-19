/**
 * Builds a schema.org/FAQPage JSON-LD object for help-centre articles and any
 * page that surfaces explicit Q&A pairs. Used by AI answer engines (ChatGPT,
 * Perplexity, Claude) and Google's rich-results FAQ snippets.
 */
export interface FaqEntry {
  q: string;
  a: string;
}

export function buildFaqJsonLd(
  entries: FaqEntry[],
): Record<string, unknown> | null {
  if (entries.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: entry.a,
      },
    })),
  };
}
