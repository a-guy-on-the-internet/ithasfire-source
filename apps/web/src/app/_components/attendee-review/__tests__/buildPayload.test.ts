import { describe, expect, it } from "vitest";

import { EMPTY, buildPayload } from "../_shared/types";

describe("buildPayload", () => {
  it("sends only the overall rating when nothing else is filled", () => {
    const payload = buildPayload("evt-1", { ...EMPTY, overallRating: 4 });
    expect(payload).toEqual({
      eventId: "evt-1",
      overallRating: 4,
      soundQuality: undefined,
      organization: undefined,
      venueComfort: undefined,
      valueForMoney: undefined,
      text: undefined,
    });
  });

  it("includes only the facets the attendee actually rated (0 = unset)", () => {
    const payload = buildPayload("evt-2", {
      ...EMPTY,
      overallRating: 5,
      soundQuality: 4,
      organization: 0, // unset — excluded
      venueComfort: 2,
      valueForMoney: 0, // unset — excluded
    });
    expect(payload.overallRating).toBe(5);
    expect(payload.soundQuality).toBe(4);
    expect(payload.venueComfort).toBe(2);
    expect(payload.organization).toBeUndefined();
    expect(payload.valueForMoney).toBeUndefined();
  });

  it("trims + caps the comment and drops whitespace-only text", () => {
    const withText = buildPayload("evt-3", {
      ...EMPTY,
      overallRating: 3,
      text: "  great show  ",
    });
    expect(withText.text).toBe("great show");

    const blank = buildPayload("evt-4", {
      ...EMPTY,
      overallRating: 3,
      text: "   \n  ",
    });
    expect(blank.text).toBeUndefined();

    const long = buildPayload("evt-5", {
      ...EMPTY,
      overallRating: 3,
      text: "x".repeat(2500),
    });
    expect(long.text?.length).toBe(2000);
  });
});
