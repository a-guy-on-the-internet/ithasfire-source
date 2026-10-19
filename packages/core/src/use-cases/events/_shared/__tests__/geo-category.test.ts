import { describe, it, expect } from "vitest";

import {
  MIN_EVENTS_PER_GEO_CATEGORY_PAGE,
  slugifyCity,
  buildCitySegment,
  parseCitySegment,
} from "../geo-category";

describe("geo-category slug helpers", () => {
  it("exposes the min-events threshold", () => {
    expect(MIN_EVENTS_PER_GEO_CATEGORY_PAGE).toBe(3);
  });

  describe("slugifyCity", () => {
    it.each([
      ["New York", "new-york"],
      ["St. Louis", "st-louis"],
      ["  San Jose  ", "san-jose"],
      ["Washington, D.C.", "washington-d-c"],
      ["O'Fallon", "o-fallon"],
      ["Nashville", "nashville"],
    ])("slugifies %j → %j", (input, expected) => {
      expect(slugifyCity(input)).toBe(expected);
    });
  });

  describe("buildCitySegment", () => {
    it("appends a 2-letter region code", () => {
      expect(buildCitySegment("Nashville", "tn")).toBe("nashville-tn");
      expect(buildCitySegment("San Jose", "CA")).toBe("san-jose-ca");
    });

    it("omits the region when absent or not a 2-letter code", () => {
      expect(buildCitySegment("Nashville", null)).toBe("nashville");
      expect(buildCitySegment("Nashville", undefined)).toBe("nashville");
      expect(buildCitySegment("Nashville", "")).toBe("nashville");
      expect(buildCitySegment("Nashville", "tennessee")).toBe("nashville");
    });
  });

  describe("parseCitySegment", () => {
    it("splits a trailing 2-letter region and keeps the city as a raw slug", () => {
      expect(parseCitySegment("nashville-tn")).toEqual({
        citySlug: "nashville",
        region: "tn",
      });
      expect(parseCitySegment("san-jose-ca")).toEqual({
        citySlug: "san-jose",
        region: "ca",
      });
      expect(parseCitySegment("st-louis-mo")).toEqual({
        citySlug: "st-louis",
        region: "mo",
      });
    });

    it("does not false-split a multi-letter final token", () => {
      expect(parseCitySegment("new-york")).toEqual({
        citySlug: "new-york",
        region: null,
      });
    });

    it("handles a single-word city with no region", () => {
      expect(parseCitySegment("nashville")).toEqual({
        citySlug: "nashville",
        region: null,
      });
    });
  });

  describe("round-trip", () => {
    it.each([
      ["Nashville", "tn"],
      ["San Jose", "ca"],
      ["New York", null],
      ["St. Louis", "mo"],
      ["Winston-Salem", "nc"],
      ["O'Fallon", "il"],
    ] as Array<[string, string | null]>)(
      "recovers citySlug + region for (%j, %j)",
      (locality, regionCode) => {
        const segment = buildCitySegment(locality, regionCode);
        const parsed = parseCitySegment(segment);
        // citySlug MUST equal the raw slug so the SQL fold matches.
        expect(parsed.citySlug).toBe(slugifyCity(locality));
        expect(parsed.region).toBe(regionCode);
      },
    );
  });
});
