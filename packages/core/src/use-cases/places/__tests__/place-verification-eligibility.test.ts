import { describe, it, expect } from "vitest";
import { getPlaceVerificationEligibility } from "../place-verification-eligibility";

const VALID_PLACE = {
  name: "The Fillmore",
  addressLine1: "1805 Geary Blvd",
  city: "San Francisco",
  countryCode: "US",
  orgIdsWithAccess: ["org-1"],
  humanIdsWithAccess: [],
};

describe("getPlaceVerificationEligibility", () => {
  it("returns eligible for a complete place", () => {
    const result = getPlaceVerificationEligibility(VALID_PLACE);
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects a placeholder name ('New Place')", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      name: "New Place",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain(
      "Place must have a real name (not a placeholder).",
    );
  });

  it("rejects an empty name", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      name: "",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("rejects a 'TBD' address", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      addressLine1: "TBD",
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Street address is required.");
  });

  it("rejects a null address", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      addressLine1: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Street address is required.");
  });

  it("rejects missing city", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      city: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("City is required.");
  });

  it("rejects missing country code", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      countryCode: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Country code is required.");
  });

  it("rejects place with no owners", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("Place must have at least one owner.");
  });

  it("accepts a place with only a human owner", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      orgIdsWithAccess: [],
      humanIdsWithAccess: ["human-1"],
    });
    expect(result.eligible).toBe(true);
  });

  it("collects multiple reasons at once", () => {
    const result = getPlaceVerificationEligibility({
      name: "",
      addressLine1: null,
      city: null,
      countryCode: null,
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.length).toBe(5);
  });

  it("is case-insensitive for placeholder checks", () => {
    const result = getPlaceVerificationEligibility({
      ...VALID_PLACE,
      name: "NEW PLACE",
    });
    expect(result.eligible).toBe(false);
  });
});
