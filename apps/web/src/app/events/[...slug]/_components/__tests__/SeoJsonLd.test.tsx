import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SeoJsonLd } from "@/components/seo/SeoJsonLd";

describe("SeoJsonLd", () => {
  it("renders a schema.org Event payload and escapes '</script>' so it can't break out of the script tag", () => {
    const html = renderToStaticMarkup(
      <SeoJsonLd
        id="x"
        data={{
          "@context": "https://schema.org",
          "@type": "Event",
          name: "Jazz Night",
          startDate: "2025-03-10T19:30:00.000Z",
          url: "https://tickets.example.com/events/jazz-night",
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "USD",
            lowPrice: "25.00",
            availability: "https://schema.org/LimitedAvailability",
            url: "https://tickets.example.com/checkout/jazz-night",
          },
          organizer: {
            "@type": "Organization",
            name: "Ithas Fire",
            url: "https://ithasfire.com",
          },
          location: {
            "@type": "Place",
            name: "Kings Theatre",
          },
          // This string would terminate the <script> tag if injected literally.
          description: "</script><script>window.__pwned = true</script>",
        }}
      />,
    );

    // Extract the embedded JSON payload (everything between the opening and closing script tags).
    // Avoid the ES2018 `s` (dotAll) regex flag so this test works with older TS targets.
    const payload = html
      .replace(/^[\s\S]*?>/, "")
      .replace(/<\/script>\s*$/i, "");

    // Spot-check that we're emitting the expected schema.org Event fields.
    expect(payload).toContain('"@context": "https://schema.org"');
    expect(payload).toContain('"@type": "Event"');
    expect(payload).toContain('"name": "Jazz Night"');
    expect(payload).toContain('"startDate": "2025-03-10T19:30:00.000Z"');
    expect(payload).toContain(
      '"url": "https://tickets.example.com/events/jazz-night"',
    );
    expect(payload).toContain('"offers"');
    expect(payload).toContain('"organizer"');
    expect(payload).toContain('"location"');

    // The serialized payload must not contain a literal '</script>' sequence.
    expect(payload.toLowerCase()).not.toContain("</script>");
    expect(payload.toLowerCase()).not.toContain("</script><script");

    // Instead, it should contain an escaped form.
    expect(payload).toContain("\\u003c/script\\u003e");
  });
});
