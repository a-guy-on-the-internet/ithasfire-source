import { describe, it, expect } from "vitest";

import { buildBreadcrumbListJsonLd } from "../buildBreadcrumbListJsonLd";

describe("buildBreadcrumbListJsonLd", () => {
  it("builds a BreadcrumbList with 1..n positions", () => {
    const result = buildBreadcrumbListJsonLd([
      { name: "Ithas Fire", url: "https://ithasfire.com" },
      { name: "Open Mics", url: "https://ithasfire.com/events/category/open-mics" },
      { name: "Open Mics in Nashville" },
    ]);

    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("BreadcrumbList");

    const elements = result.itemListElement as Record<string, unknown>[];
    expect(elements).toHaveLength(3);

    expect(elements[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      name: "Ithas Fire",
      item: "https://ithasfire.com",
    });
    expect(elements[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      name: "Open Mics",
      item: "https://ithasfire.com/events/category/open-mics",
    });
  });

  it("omits the item URL on the last crumb even when a url is given", () => {
    const result = buildBreadcrumbListJsonLd([
      { name: "Home", url: "https://ithasfire.com" },
      { name: "Current", url: "https://ithasfire.com/current" },
    ]);
    const elements = result.itemListElement as Record<string, unknown>[];
    expect(elements[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      name: "Current",
    });
    expect(elements[1]).not.toHaveProperty("item");
  });

  it("DROPS a non-last crumb without a url and renumbers 1..n", () => {
    // Google requires `item` on every crumb but the last; an item-less middle
    // crumb is a CRITICAL Search Console error that loses the whole list.
    const result = buildBreadcrumbListJsonLd([
      { name: "Home", url: "https://ithasfire.com" },
      { name: "US" },
      { name: "Events", url: "https://ithasfire.com/search" },
      { name: "NASHVILLE" },
      { name: "Leaf" },
    ]);
    expect(result.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://ithasfire.com",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Events",
        item: "https://ithasfire.com/search",
      },
      { "@type": "ListItem", position: 3, name: "Leaf" },
    ]);
  });

  it("drops a url-less FIRST crumb too", () => {
    const result = buildBreadcrumbListJsonLd([
      { name: "Home" },
      { name: "Leaf" },
    ]);
    expect(result.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Leaf" },
    ]);
  });

  it("never emits a non-last crumb without `item`, whatever the input", () => {
    const result = buildBreadcrumbListJsonLd([
      { name: "A" },
      { name: "B", url: "https://x.test/b" },
      { name: "C", url: "" },
      { name: "D", url: "https://x.test/d" },
      { name: "E" },
    ]);
    const elements = result.itemListElement as Record<string, unknown>[];
    elements.slice(0, -1).forEach((el, i) => {
      expect(el.item).toBeTruthy();
      expect(el.position).toBe(i + 1);
    });
    expect(elements.at(-1)).toEqual({
      "@type": "ListItem",
      position: elements.length,
      name: "E",
    });
  });

  it("returns an empty list for no crumbs", () => {
    expect(buildBreadcrumbListJsonLd([]).itemListElement).toEqual([]);
  });

  it("keeps the category routes' output byte-identical (every middle crumb has a url)", () => {
    // The shapes `category-route.tsx` and `geo-category-route.tsx` pass.
    const category = buildBreadcrumbListJsonLd([
      { name: "Ithas Fire", url: "https://ithasfire.com/" },
      { name: "Events", url: "https://ithasfire.com/search" },
      { name: "Open Mics" },
    ]);
    expect(JSON.stringify(category)).toBe(
      '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[' +
        '{"@type":"ListItem","position":1,"name":"Ithas Fire","item":"https://ithasfire.com/"},' +
        '{"@type":"ListItem","position":2,"name":"Events","item":"https://ithasfire.com/search"},' +
        '{"@type":"ListItem","position":3,"name":"Open Mics"}]}',
    );

    const geo = buildBreadcrumbListJsonLd([
      { name: "Ithas Fire", url: "https://ithasfire.com/" },
      { name: "Events", url: "https://ithasfire.com/search" },
      {
        name: "Open Mics",
        url: "https://ithasfire.com/events/category/open-mics",
      },
      { name: "Nashville, TN" },
    ]);
    expect(JSON.stringify(geo)).toBe(
      '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[' +
        '{"@type":"ListItem","position":1,"name":"Ithas Fire","item":"https://ithasfire.com/"},' +
        '{"@type":"ListItem","position":2,"name":"Events","item":"https://ithasfire.com/search"},' +
        '{"@type":"ListItem","position":3,"name":"Open Mics","item":"https://ithasfire.com/events/category/open-mics"},' +
        '{"@type":"ListItem","position":4,"name":"Nashville, TN"}]}',
    );
  });
});
