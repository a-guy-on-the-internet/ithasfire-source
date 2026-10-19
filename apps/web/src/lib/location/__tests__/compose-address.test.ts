import { describe, expect, it } from "vitest";

import { composeEventAddress } from "../compose-address";

describe("composeEventAddress", () => {
  it("does not repeat a city and region the free-form line already carries", () => {
    // The exact shipped bug, with the exact seeded row behind it.
    expect(
      composeEventAddress({
        addressText:
          "Springwater Supper Club & Lounge, 115 27th Ave N, Nashville, TN",
        locality: "Nashville",
        region: "TN",
        postalCode: "37203",
        countryCode: "US",
      }),
    ).toBe(
      "Springwater Supper Club & Lounge, 115 27th Ave N, Nashville, TN, 37203, US",
    );
  });

  it("still appends a city and region a bare street line does not carry", () => {
    expect(
      composeEventAddress({
        addressText: "1027 Flatbush Ave",
        locality: "Brooklyn",
        region: "NY",
        postalCode: "11226",
        countryCode: "US",
      }),
    ).toBe("1027 Flatbush Ave, Brooklyn, NY, 11226, US");
  });

  it("does not re-append a region or ZIP packed into one \"TN 37203\" segment", () => {
    // The standard US postal form puts both in a single comma segment, so
    // whole-segment matching alone printed each of them twice. MEASURED on a
    // quick-created community listing, whose geocode lands complete in
    // `addressText`.
    expect(
      composeEventAddress({
        addressText: "Springwater, 115 27th Avenue North, Nashville, TN 37203",
        locality: "Nashville",
        region: "TN",
        postalCode: "37203",
        countryCode: "US",
      }),
    ).toBe("Springwater, 115 27th Avenue North, Nashville, TN 37203, US");
  });

  it("drops the region and country in the OTHER spelling once the line is postal-complete", () => {
    // The real row behind this: the quick-create geocoder stored the long forms
    // ("Tennessee", and a country name in the line) while the line itself uses
    // the codes. Nothing string-comparable matches, so the line is parsed:
    // "TN 37203" is the postal segment, and the segment after it is the
    // country — all three structured parts are already stated.
    expect(
      composeEventAddress({
        addressText:
          "Springwater, 115 27th Avenue North, Nashville, TN 37203, United States of America",
        locality: "Nashville",
        region: "Tennessee",
        postalCode: "37203",
        countryCode: "US",
      }),
    ).toBe(
      "Springwater, 115 27th Avenue North, Nashville, TN 37203, United States of America",
    );

    // No country segment after the postal one ⇒ the country IS still appended.
    expect(
      composeEventAddress({
        addressText: "115 27th Avenue North, Nashville, TN 37203",
        region: "Tennessee",
        postalCode: "37203",
        countryCode: "US",
      }),
    ).toBe("115 27th Avenue North, Nashville, TN 37203, US");
  });

  it("parses a postal tail conservatively — a street is never mistaken for one", () => {
    // No postal-code-shaped last token: no parse, and the street-name
    // protection above is untouched.
    expect(
      composeEventAddress({
        addressText: "100 Nashville Ave",
        locality: "Nashville",
        region: "TN",
      }),
    ).toBe("100 Nashville Ave, Nashville, TN");

    // A postal-shaped token whose head contains digits is a street number, so
    // the region and ZIP are still genuinely missing and get appended.
    expect(
      composeEventAddress({
        addressText: "115 27th Avenue North 37203",
        region: "TN",
        postalCode: "37203",
      }),
    ).toBe("115 27th Avenue North 37203, TN, 37203");

    // …and a head longer than a region name is likewise not one.
    expect(
      composeEventAddress({
        addressText: "The Old Fire Station Hall 37203",
        region: "TN",
      }),
    ).toBe("The Old Fire Station Hall 37203, TN");
  });

  it("matches whole segments only, so a city in a STREET NAME is not swallowed", () => {
    // The reason this dedupes on segments rather than substrings: "nashville"
    // appears inside the street, but the event is in Memphis and the locality
    // is genuinely Nashville-free.
    expect(
      composeEventAddress({
        addressText: "100 Nashville Ave",
        locality: "Memphis",
        region: "TN",
      }),
    ).toBe("100 Nashville Ave, Memphis, TN");

    // And the inverse: a street containing the city's own name must not cause
    // the city to be dropped.
    expect(
      composeEventAddress({
        addressText: "100 Nashville Ave",
        locality: "Nashville",
        region: "TN",
      }),
    ).toBe("100 Nashville Ave, Nashville, TN");
  });

  it("ignores case and punctuation differences between importers", () => {
    expect(
      composeEventAddress({
        addressText: "55 Main St., NASHVILLE, Tn",
        locality: "Nashville",
        region: "TN",
        postalCode: "37201",
      }),
    ).toBe("55 Main St., NASHVILLE, Tn, 37201");
  });

  it("keeps addressLine2 and dedupes against it too", () => {
    expect(
      composeEventAddress({
        addressText: "115 27th Ave N",
        addressLine2: "Suite 4",
        locality: "Nashville",
        region: "TN",
      }),
    ).toBe("115 27th Ave N, Suite 4, Nashville, TN");
  });

  it("drops a region that merely repeats the city, and empty values", () => {
    expect(
      composeEventAddress({
        addressText: "Somewhere Hall",
        locality: "Singapore",
        region: "Singapore",
        countryCode: "SG",
      }),
    ).toBe("Somewhere Hall, Singapore, SG");

    expect(
      composeEventAddress({
        addressText: "  ",
        locality: "",
        region: null,
        postalCode: undefined,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when nothing is known, so it stays a render gate", () => {
    expect(composeEventAddress({})).toBeUndefined();
  });

  it("composes from the tail alone when there is no free-form line", () => {
    expect(
      composeEventAddress({ locality: "Austin", region: "TX", countryCode: "US" }),
    ).toBe("Austin, TX, US");
  });
});
