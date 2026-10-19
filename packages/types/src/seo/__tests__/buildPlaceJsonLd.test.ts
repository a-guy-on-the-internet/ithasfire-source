import { describe, it, expect } from "vitest";
import { buildPlaceJsonLd } from "../buildPlaceJsonLd";
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

describe("buildPlaceJsonLd", () => {
  it("produces a valid schema.org/Place object", () => {
    const result = buildPlaceJsonLd(basePlace);

    expect(result["@context"]).toBe("https://schema.org");
    expect(result["@type"]).toBe("Place");
    expect(result.name).toBe("The Grand Arena");
    expect(result.url).toBe("https://example.com/places/id/place-001");
  });

  it("includes PostalAddress when address fields are present", () => {
    const result = buildPlaceJsonLd(basePlace);
    const address = result.address as Record<string, unknown>;

    expect(address["@type"]).toBe("PostalAddress");
    expect(address.streetAddress).toBe("123 Main St, Melbourne");
    expect(address.addressLocality).toBe("Melbourne");
    expect(address.addressRegion).toBe("VIC");
    expect(address.addressCountry).toBe("AU");
  });

  it("includes GeoCoordinates when lat/lng are present", () => {
    const result = buildPlaceJsonLd(basePlace);
    const geo = result.geo as Record<string, unknown>;

    expect(geo["@type"]).toBe("GeoCoordinates");
    expect(geo.latitude).toBe(-37.8136);
    expect(geo.longitude).toBe(144.9631);
  });

  it("includes maximumAttendeeCapacity when capacity > 0", () => {
    const result = buildPlaceJsonLd(basePlace);
    expect(result.maximumAttendeeCapacity).toBe(5000);
  });

  it("omits address when no address fields are present", () => {
    const minimal: SeoPlace = {
      placeId: "place-002",
      url: "https://example.com/places/id/place-002",
      name: "Mystery Venue",
    };
    const result = buildPlaceJsonLd(minimal);

    expect(result.address).toBeUndefined();
    expect(result.geo).toBeUndefined();
    expect(result.maximumAttendeeCapacity).toBeUndefined();
  });

  it("omits geo when lat/lng are null", () => {
    const noGeo: SeoPlace = {
      ...basePlace,
      lat: null,
      lng: null,
    };
    const result = buildPlaceJsonLd(noGeo);
    expect(result.geo).toBeUndefined();
  });

  it("omits capacity when zero or null", () => {
    const noCapacity: SeoPlace = {
      ...basePlace,
      capacity: 0,
    };
    expect(
      buildPlaceJsonLd(noCapacity).maximumAttendeeCapacity,
    ).toBeUndefined();

    const nullCapacity: SeoPlace = {
      ...basePlace,
      capacity: null,
    };
    expect(
      buildPlaceJsonLd(nullCapacity).maximumAttendeeCapacity,
    ).toBeUndefined();
  });
});
