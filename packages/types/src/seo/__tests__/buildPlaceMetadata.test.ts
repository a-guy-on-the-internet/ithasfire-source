import { describe, it, expect } from "vitest";
import { buildPlaceMetadata } from "../buildPlaceMetadata";
import type { SeoPlace } from "../types";

const basePlace: SeoPlace = {
  placeId: "place-001",
  url: "https://example.com/places/id/place-001",
  name: "The Grand Arena",
  formattedAddress: "123 Main St, Melbourne",
  city: "Melbourne",
  region: "VIC",
  countryCode: "AU",
  lat: -37.8136,
  lng: 144.9631,
  capacity: 5000,
};

describe("buildPlaceMetadata", () => {
  it("returns title and description", () => {
    const meta = buildPlaceMetadata({ place: basePlace, siteName: "TestSite" });
    expect(meta.title).toBe("The Grand Arena");
    expect(String(meta.title)).not.toContain("TestSite");
    expect((meta.openGraph as { siteName?: string }).siteName).toBe("TestSite");
    expect(meta.description).toBe(
      "Events at The Grand Arena — Melbourne, VIC, AU",
    );
  });

  it("includes canonical URL in alternates", () => {
    const meta = buildPlaceMetadata({ place: basePlace, siteName: "TestSite" });
    expect(meta.alternates?.canonical).toBe(
      "https://example.com/places/id/place-001",
    );
  });

  it("includes openGraph metadata", () => {
    const meta = buildPlaceMetadata({ place: basePlace, siteName: "TestSite" });
    expect(meta.openGraph).toBeDefined();
    const og = meta.openGraph as Record<string, unknown>;
    expect(og.type).toBe("website");
    expect(og.url).toBe("https://example.com/places/id/place-001");
    expect(og.siteName).toBe("TestSite");
  });

  it("includes twitter metadata", () => {
    const meta = buildPlaceMetadata({ place: basePlace, siteName: "TestSite" });
    expect(meta.twitter).toBeDefined();
    const tw = meta.twitter as Record<string, unknown>;
    expect(tw.card).toBe("summary");
  });

  it("sets robots to index when shouldIndex is true", () => {
    const meta = buildPlaceMetadata({
      place: basePlace,
      siteName: "TestSite",
      shouldIndex: true,
    });
    const robots = meta.robots as Record<string, boolean>;
    expect(robots.index).toBe(true);
    expect(robots.follow).toBe(true);
  });

  it("sets robots to noindex when shouldIndex is false", () => {
    const meta = buildPlaceMetadata({
      place: basePlace,
      siteName: "TestSite",
      shouldIndex: false,
    });
    const robots = meta.robots as Record<string, boolean>;
    expect(robots.index).toBe(false);
    expect(robots.follow).toBe(false);
  });

  it("defaults shouldIndex to true", () => {
    const meta = buildPlaceMetadata({ place: basePlace, siteName: "TestSite" });
    const robots = meta.robots as Record<string, boolean>;
    expect(robots.index).toBe(true);
  });

  it("handles place with minimal address fields", () => {
    const minimal: SeoPlace = {
      placeId: "place-002",
      url: "https://example.com/places/id/place-002",
      name: "Mystery Venue",
    };
    const meta = buildPlaceMetadata({ place: minimal, siteName: "TestSite" });
    expect(meta.description).toBe("Events at Mystery Venue");
  });
});
