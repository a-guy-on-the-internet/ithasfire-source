import { describe, expect, it } from "vitest";
import type { EventSummary } from "@th/ui";

import { mergeCategoryEvents } from "../useCategoryBrowse";

/**
 * The category grid draws from two sources that are COMPLEMENTARY.
 *
 * Measured on one live batch of the same seven events: the search path carried
 * a real `priceLabel` and no media for any of them; the DB path carried media
 * for all of them and `priceLabel: "See details"`. Preferring either wholesale
 * loses half of every card — which is why category cards rendered with prices
 * and ghosted-initials placeholders where their photos should have been.
 */
const searchRow = (over: Partial<EventSummary> = {}): EventSummary => ({
  id: "evt-1",
  title: "Brooklyn Warehouse Showcase",
  date: "Sat, Sep 5",
  venue: "319 Scholes St",
  priceLabel: "$51.29",
  ...over,
});

const dbRow = (over: Partial<EventSummary> = {}): EventSummary => ({
  id: "evt-1",
  title: "Brooklyn Warehouse Showcase",
  date: "Sat, Sep 5",
  venue: "319 Scholes St",
  priceLabel: "See details",
  media: { url: "https://img.test/hero.jpg", alt: "Hero" },
  ...over,
});

describe("mergeCategoryEvents", () => {
  it("keeps the search price and takes the image the search index lacks", () => {
    const [merged] = mergeCategoryEvents([searchRow()], [dbRow()]);

    expect(merged?.priceLabel).toBe("$51.29");
    expect(merged?.media?.url).toBe("https://img.test/hero.jpg");
  });

  it("keeps the DB row's zone, which the search row lacks", () => {
    const [merged] = mergeCategoryEvents(
      [searchRow()],
      [dbRow({ timezone: "America/New_York" })],
    );
    expect(merged?.timezone).toBe("America/New_York");
  });

  it("does not let 'See details' overwrite a real price", () => {
    // "See details" is the mappers' shared "we don't know", not an answer.
    const [merged] = mergeCategoryEvents([searchRow()], [dbRow()]);
    expect(merged?.priceLabel).not.toBe("See details");
  });

  it("takes a real price from the DB row when search has only the placeholder", () => {
    const [merged] = mergeCategoryEvents(
      [searchRow({ priceLabel: "See details" })],
      [dbRow({ priceLabel: "$12", isFree: false })],
    );
    expect(merged?.priceLabel).toBe("$12");
  });

  it("preserves search ordering", () => {
    const merged = mergeCategoryEvents(
      [searchRow({ id: "b" }), searchRow({ id: "a" })],
      [dbRow({ id: "a" }), dbRow({ id: "b" })],
    );
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("passes an event through untouched when the DB result does not contain it", () => {
    const merged = mergeCategoryEvents([searchRow({ id: "orphan" })], [dbRow()]);
    expect(merged[0]?.media).toBeUndefined();
    expect(merged[0]?.id).toBe("orphan");
  });

  it("is a no-op when there is no fallback to merge", () => {
    const rows = [searchRow()];
    expect(mergeCategoryEvents(rows, undefined)).toBe(rows);
  });
});
