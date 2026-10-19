import { describe, expect, it } from "vitest";

import {
  addressVenueChanged,
  normalizeStreetLine,
  streetLineChanged,
  VENUE_MOVE_THRESHOLD_METERS,
  venueMoved,
} from "../_shared/venue-moved";

// ~1 m of latitude in degrees.
const METRE = 1 / 111_195;

describe("venueMoved", () => {
  const here = { lat: 30.2697, lng: -97.7363 };

  it("is false for the same pin", () => {
    expect(venueMoved(here, here)).toBe(false);
  });

  it("is false for a move under the threshold", () => {
    expect(venueMoved(here, { lat: here.lat + 40 * METRE, lng: here.lng })).toBe(false);
  });

  it("is false just under the threshold (only MORE than 50 m counts)", () => {
    expect(VENUE_MOVE_THRESHOLD_METERS).toBe(50);
    expect(venueMoved(here, { lat: here.lat + 49.9 * METRE, lng: here.lng })).toBe(false);
  });

  it("is true for a move over the threshold", () => {
    expect(venueMoved(here, { lat: here.lat + 60 * METRE, lng: here.lng })).toBe(true);
  });

  it("is true when a pin appears where there was none", () => {
    expect(venueMoved({ lat: null, lng: null }, here)).toBe(true);
  });

  it("is false when neither side has a pin", () => {
    expect(venueMoved({ lat: null, lng: null }, { lat: null, lng: null })).toBe(false);
  });
});

// The incident listing (Nashville, 2026-10-14).
const STORED_TEXT =
  "211 27th Avenue North, Nashville, TN 37203, United States of America";

describe("normalizeStreetLine", () => {
  it("takes the street segment and drops locality, region, postcode and country", () => {
    expect(normalizeStreetLine(STORED_TEXT, ["37203"])).toBe("211 27th ave n");
  });

  it("folds suffixes and directionals, keeps ordinals and house numbers", () => {
    expect(normalizeStreetLine("211 27th Ave. N, Nashville")).toBe("211 27th ave n");
    expect(normalizeStreetLine("1 Main Street, Austin")).toBe("1 main st");
    expect(normalizeStreetLine("40 West Boulevard")).toBe("40 w blvd");
  });

  it("skips a place name in front of the street (name-first)", () => {
    expect(
      normalizeStreetLine("Virgin Hotel, 1 Music Square West, Nashville, TN 37203"),
    ).toBe("1 music sq w");
  });

  it("keeps a leading unit and skips the name after it (unit-first)", () => {
    expect(
      normalizeStreetLine("Unit A, Red Bicycle, 2190 Nolensville Pike, Nashville, TN 37211"),
    ).toBe("#a 2190 nolensville pike");
  });

  it("writes every unit spelling in one form", () => {
    for (const unit of ["Unit 4", "Ste 4", "Ste. 4", "Suite #4", "Apt 4", "#4", "# 4"]) {
      expect(normalizeStreetLine(`${unit}, 2190 Nolensville Pike, Nashville`)).toBe(
        "#4 2190 nolensville pike",
      );
    }
  });

  it("does not read a name that starts with a unit word as a unit", () => {
    expect(normalizeStreetLine("United Artists, 1 Main St")).toBe("1 main st");
  });

  it("takes a street-name-first segment with its number, and a later number-led segment with it", () => {
    expect(normalizeStreetLine("Hauptstraße 5, 10115 Berlin")).toBe(
      "hauptstraße 5 10115 berlin",
    );
    expect(normalizeStreetLine("Building 3, 100 Main St, Austin")).toBe(
      "building 3 100 main st",
    );
    expect(normalizeStreetLine("Hauptstraße 5, Berlin, Germany")).toBe("hauptstraße 5");
  });

  it("falls back to the first segment when no segment starts with a number", () => {
    expect(normalizeStreetLine("Centennial Park, Nashville, TN")).toBe("centennial park");
  });

  it("does not take a postcode-led segment for the street when the postcode is known", () => {
    expect(normalizeStreetLine("Hauptstraße 5, 10115 Berlin, Germany", ["10115"])).toBe(
      "hauptstraße 5",
    );
  });

  it("removes a postcode only as a whole token, never from inside a house number", () => {
    expect(normalizeStreetLine("137203 Main St", ["37203"])).toBe("137203 main st");
  });

  it("is empty for a missing address", () => {
    expect(normalizeStreetLine(null)).toBe("");
    expect(normalizeStreetLine("  ,  ")).toBe("");
  });
});

describe("streetLineChanged", () => {
  it("is false for byte-identical text", () => {
    expect(
      streetLineChanged(
        { addressText: STORED_TEXT, postalCode: "37203" },
        { addressText: STORED_TEXT, postalCode: "37203" },
      ),
    ).toBe(false);
  });

  it("is false for the same street reformatted, country dropped, postcode changed", () => {
    expect(
      streetLineChanged(
        { addressText: STORED_TEXT, postalCode: "37203" },
        { addressText: "211 27th Ave N, Nashville, TN 37209", postalCode: "37209" },
      ),
    ).toBe(false);
  });

  it("is false re-picking the same name-first and unit-first text", () => {
    const virgin = "Virgin Hotel, 1 Music Square West, Nashville, TN 37203";
    const bicycle = "Unit A, Red Bicycle, 2190 Nolensville Pike, Nashville";
    expect(streetLineChanged({ addressText: virgin }, { addressText: virgin })).toBe(false);
    expect(streetLineChanged({ addressText: bicycle }, { addressText: bicycle })).toBe(false);
  });

  it("is true for the house next door on a street-name-first address with no postcode", () => {
    expect(
      streetLineChanged(
        { addressText: "Hauptstraße 5, 10115 Berlin" },
        { addressText: "Hauptstraße 7, 10115 Berlin" },
      ),
    ).toBe(true);
  });

  it("is false re-picking a street-name-first address with no postcode", () => {
    const berlin = "Hauptstraße 5, 10115 Berlin";
    expect(streetLineChanged({ addressText: berlin }, { addressText: berlin })).toBe(false);
  });

  it("is true for a different house number behind a numbered name", () => {
    expect(
      streetLineChanged(
        { addressText: "Building 3, 100 Main St, Austin" },
        { addressText: "Building 3, 102 Main St, Austin" },
      ),
    ).toBe(true);
  });

  it("is true for a different unit at the same street address", () => {
    expect(
      streetLineChanged(
        { addressText: "Unit A, Red Bicycle, 2190 Nolensville Pike, Nashville" },
        { addressText: "Unit C, Taqueria, 2190 Nolensville Pike, Nashville" },
      ),
    ).toBe(true);
  });

  it("is false for the same unit spelled another way", () => {
    expect(
      streetLineChanged(
        { addressText: "Suite 4, 2190 Nolensville Pike, Nashville" },
        { addressText: "#4, 2190 Nolensville Pike, Nashville, TN 37211" },
      ),
    ).toBe(false);
  });

  it("is false for the name-first shape re-formatted", () => {
    expect(
      streetLineChanged(
        { addressText: "Virgin Hotel, 1 Music Square West, Nashville, TN 37203" },
        { addressText: "1 Music Sq W, Nashville" },
      ),
    ).toBe(false);
  });

  it("is true for a different house number (next door)", () => {
    expect(
      streetLineChanged(
        { addressText: STORED_TEXT },
        { addressText: "213 27th Avenue North, Nashville, TN 37203" },
      ),
    ).toBe(true);
  });

  it("is true for the reverse geocode of the incident's unchanged pin", () => {
    expect(
      streetLineChanged(
        { addressText: STORED_TEXT, postalCode: "37203" },
        { addressText: "245 25th Avenue North, Nashville, TN 37203", postalCode: "37203" },
      ),
    ).toBe(true);
  });
});

describe("addressVenueChanged", () => {
  const here = { lat: 36.1497, lng: -86.8126 };

  it("is quiet for the same street line with the pin 10 m off", () => {
    expect(
      addressVenueChanged(
        { ...here, addressText: STORED_TEXT, postalCode: "37203" },
        {
          lat: here.lat + 10 * METRE,
          lng: here.lng,
          addressText: "211 27th Ave N, Nashville, TN 37209",
          postalCode: "37209",
        },
      ),
    ).toBe(false);
  });

  it("is a change for a different street line at the SAME pin", () => {
    expect(
      addressVenueChanged(
        { ...here, addressText: STORED_TEXT },
        { ...here, addressText: "245 25th Avenue North, Nashville, TN 37203" },
      ),
    ).toBe(true);
  });

  it("is a change for the same text with the pin moved over 50 m", () => {
    expect(
      addressVenueChanged(
        { ...here, addressText: STORED_TEXT },
        { lat: here.lat + 60 * METRE, lng: here.lng, addressText: STORED_TEXT },
      ),
    ).toBe(true);
  });
});
