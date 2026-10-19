import { describe, expect, it } from "vitest";
import { extractViewerLocation } from "./viewer-location";

describe("extractViewerLocation", () => {
  it("returns null when no geolocation hints are present", () => {
    expect(extractViewerLocation(null)).toBeNull();
    expect(extractViewerLocation({})).toBeNull();
    expect(
      extractViewerLocation({
        "x-random-header": "value",
      }),
    ).toBeNull();
  });

  it("parses Vercel geo headers and computes a geohash", () => {
    const location = extractViewerLocation({
      "x-vercel-ip-city": "San Francisco",
      "x-vercel-ip-country": "US",
      "x-vercel-ip-country-region": "CA",
      "x-vercel-ip-latitude": "37.7749",
      "x-vercel-ip-longitude": "-122.4194",
      "x-vercel-ip-timezone": "America/Los_Angeles",
      "x-forwarded-for": "203.0.113.2",
    });

    expect(location).not.toBeNull();
    expect(location).toMatchObject({
      source: "vercel",
      city: "San Francisco",
      regionCode: "CA",
      countryCode: "US",
      latitude: 37.7749,
      longitude: -122.4194,
      geohash: "9q8yyk",
      timezone: "America/Los_Angeles",
      postalCode: null,
      accuracyRadiusKm: null,
      ip: "203.0.113.2",
    });
  });

  it("parses Cloudflare headers and normalizes IPv6 values", () => {
    const location = extractViewerLocation({
      "cf-ipcity": "New York",
      "cf-ipcountry": "US",
      "cf-region-code": "NY",
      "cf-iplatitude": "40.7128",
      "cf-iplongitude": "-74.0060",
      "cf-accuracy-meters": "35",
      "cf-connecting-ip": "2606:2800:220:1:248:1893:25c8:1946",
    });

    expect(location).not.toBeNull();
    expect(location).toMatchObject({
      source: "cloudflare",
      city: "New York",
      regionCode: "NY",
      countryCode: "US",
      latitude: 40.7128,
      longitude: -74.006,
      geohash: "dr5reg",
      accuracyRadiusKm: 0.035,
      ip: "2606:2800:220:1:248:1893:25c8:1946",
    });
  });

  it("falls back to App Engine citylatlong payloads", () => {
    const location = extractViewerLocation({
      "x-appengine-city": "Los Angeles",
      "x-appengine-country": "US",
      "x-appengine-region": "CA",
      "x-appengine-user-ip": "198.51.100.10",
      "x-appengine-citylatlong": "(34.0522,-118.2437)",
    });

    expect(location).not.toBeNull();
    expect(location).toMatchObject({
      source: "gcp",
      city: "Los Angeles",
      regionCode: "CA",
      countryCode: "US",
      latitude: 34.0522,
      longitude: -118.2437,
      geohash: "9q5ctr",
      ip: "198.51.100.10",
    });
  });
});
