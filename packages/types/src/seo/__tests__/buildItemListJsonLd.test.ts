import { describe, expect, it } from "vitest";

import { buildItemListJsonLd, type ItemListItem } from "../buildItemListJsonLd";

describe("buildItemListJsonLd", () => {
  it("returns null for empty array", () => {
    expect(buildItemListJsonLd([])).toBeNull();
  });

  it("returns valid ItemList with correct positions", () => {
    const items: ItemListItem[] = [
      { url: "https://example.com/events/event-1", name: "Event One" },
      { url: "https://example.com/events/event-2", name: "Event Two" },
    ];

    const result = buildItemListJsonLd(items);

    expect(result).not.toBeNull();
    expect(result!["@context"]).toBe("https://schema.org");
    expect(result!["@type"]).toBe("ItemList");
    expect(result!.numberOfItems).toBe(2);

    const elements = result!.itemListElement as Record<string, unknown>[];
    expect(elements).toHaveLength(2);

    expect(elements[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      url: "https://example.com/events/event-1",
      name: "Event One",
    });

    expect(elements[1]).toEqual({
      "@type": "ListItem",
      position: 2,
      url: "https://example.com/events/event-2",
      name: "Event Two",
    });
  });

  it("handles single item", () => {
    const result = buildItemListJsonLd([
      { url: "https://example.com/events/only", name: "Only Event" },
    ]);

    expect(result).not.toBeNull();
    expect(result!.numberOfItems).toBe(1);
    const elements = result!.itemListElement as Record<string, unknown>[];
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ position: 1 });
  });
});
