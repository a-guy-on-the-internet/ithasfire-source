import { describe, expect, it } from "vitest";

import {
  buildEventBreadcrumbJsonLd,
  type BreadcrumbJsonLdInput,
} from "../buildEventBreadcrumbJsonLd";

const BASE_INPUT: BreadcrumbJsonLdInput = {
  eventName: "Summer Fest 2025",
  siteUrl: "https://ithasfire.com",
  siteName: "Ithas Fire",
};

describe("buildEventBreadcrumbJsonLd", () => {
  it("returns Home › Events › Event title", () => {
    const result = buildEventBreadcrumbJsonLd(BASE_INPUT);

    expect(result).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Ithas Fire",
          item: "https://ithasfire.com",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Events",
          item: "https://ithasfire.com/search",
        },
        // Last crumb: the current page, no `item` URL.
        { "@type": "ListItem", position: 3, name: "Summer Fest 2025" },
      ],
    });
  });

  it("gives every crumb but the last an `item` (Search Console's CRITICAL check)", () => {
    const items = buildEventBreadcrumbJsonLd(BASE_INPUT)
      .itemListElement as Record<string, unknown>[];
    for (const crumb of items.slice(0, -1)) {
      expect(typeof crumb.item).toBe("string");
      expect(crumb.item).not.toBe("");
    }
    expect(items.at(-1)).not.toHaveProperty("item");
  });

  it("carries no country or region crumb (no page lists events by either)", () => {
    // The prod list was Home › Events › "US" › "NASHVILLE" › title, with the
    // two middle crumbs item-less.
    const names = (
      buildEventBreadcrumbJsonLd(BASE_INPUT).itemListElement as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(names).toEqual(["Ithas Fire", "Events", "Summer Fest 2025"]);
  });
});
