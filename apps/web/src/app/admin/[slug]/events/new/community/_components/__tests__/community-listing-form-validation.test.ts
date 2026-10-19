import { describe, expect, it } from "vitest";

import {
  validateCommunityListingForm,
  type CommunityListingFormValues,
} from "../community-listing-form-validation";

const validValues: CommunityListingFormValues = {
  title: "Tuesday open mic",
  startsAtLocal: "2026-08-04T19:00",
  endsAtLocal: "2026-08-04T22:00",
  timezone: "America/Chicago",
  addressText: "123 Main St, Austin, TX",
  geo: {
    countryCode: "us",
    region: "TX",
    locality: "Austin",
    postalCode: "78701",
    lat: 30.2672,
    lng: -97.7431,
  },
  categoryId: "",
  ageLimitRaw: "",
};

describe("validateCommunityListingForm", () => {
  it("builds a contract-shaped payload from valid values", () => {
    const result = validateCommunityListingForm(validValues);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload).toMatchObject({
      title: "Tuesday open mic",
      timezone: "America/Chicago",
      addressText: "123 Main St, Austin, TX",
      countryCode: "US", // uppercased for the contract
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.2672,
      lng: -97.7431,
    });
    // datetime-local + timezone → UTC instants (CDT = UTC-5 on this date).
    expect(result.payload.startsAt).toBe("2026-08-05T00:00:00.000Z");
    expect(result.payload.endsAt).toBe("2026-08-05T03:00:00.000Z");
    // Optionals omitted, not sent as empty strings.
    expect("categoryId" in result.payload).toBe(false);
    expect("ageLimit" in result.payload).toBe(false);
  });

  it("includes categoryId and parsed ageLimit when provided", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      categoryId: "0f0e0d0c-0b0a-4a4b-8c8d-1e1f2a2b3c3d",
      ageLimitRaw: "18",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.categoryId).toBe(
      "0f0e0d0c-0b0a-4a4b-8c8d-1e1f2a2b3c3d",
    );
    expect(result.payload.ageLimit).toBe(18);
  });

  it("requires title, start and end", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      title: "   ",
      startsAtLocal: "",
      endsAtLocal: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toBe("titleRequired");
    expect(result.errors.startsAt).toBe("startsRequired");
    expect(result.errors.endsAt).toBe("endsRequired");
  });

  it("says part of the value is missing when the inputs are half-typed", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      startsAtLocal: "",
      endsAtLocal: "",
      startsIncomplete: true,
      endsIncomplete: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.startsAt).toBe("startsIncomplete");
    expect(result.errors.endsAt).toBe("endsIncomplete");
  });

  it("keeps the required message for empty inputs that are not half-typed", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      startsAtLocal: "",
      endsAtLocal: "",
      startsIncomplete: false,
      endsIncomplete: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.startsAt).toBe("startsRequired");
    expect(result.errors.endsAt).toBe("endsRequired");
  });

  it("ignores the incomplete flag when the field has a value", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      startsIncomplete: true,
      endsIncomplete: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects end at or before start", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      endsAtLocal: validValues.startsAtLocal,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.endsAt).toBe("endsBeforeStarts");
  });

  it("requires a selected geocoded location", () => {
    const result = validateCommunityListingForm({ ...validValues, geo: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.location).toBe("locationRequired");
  });

  it("rejects a geocode result without a country code (contract requires it)", () => {
    const result = validateCommunityListingForm({
      ...validValues,
      geo: { ...validValues.geo!, countryCode: null },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.location).toBe("countryMissing");
  });

  it("rejects non-numeric or out-of-shape age limits", () => {
    for (const raw of ["abc", "-1", "1.5", "100"]) {
      const result = validateCommunityListingForm({
        ...validValues,
        ageLimitRaw: raw,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.errors.ageLimit).toBe("ageLimitInvalid");
    }
  });

  it("accepts boundary age limits 0 and 99", () => {
    for (const raw of ["0", "99"]) {
      const result = validateCommunityListingForm({
        ...validValues,
        ageLimitRaw: raw,
      });
      expect(result.ok).toBe(true);
    }
  });
});
