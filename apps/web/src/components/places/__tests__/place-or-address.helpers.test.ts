import { describe, expect, it } from "vitest";

import {
  formatRetryIn,
  placeRowSubtitle,
  readExistingPlace,
  readRetryAt,
  toRefusalReason,
} from "../place-or-address.helpers";

describe("placeRowSubtitle", () => {
  it("adds the city when the street line lacks it", () => {
    expect(placeRowSubtitle("2190 Nolensville Pike", "Nashville")).toBe(
      "2190 Nolensville Pike, Nashville",
    );
  });
  it("does not repeat a city the street line carries", () => {
    expect(placeRowSubtitle("2190 Nolensville Pike, Nashville", "Nashville")).toBe(
      "2190 Nolensville Pike, Nashville",
    );
  });
  it("falls back to whichever exists", () => {
    expect(placeRowSubtitle(null, "Nashville")).toBe("Nashville");
    expect(placeRowSubtitle(null, null)).toBeNull();
  });
});

describe("reading refusals", () => {
  it("reads the existing place off PLACE_ALREADY_EXISTS", () => {
    const err = {
      data: {
        meta: {
          existingPlace: {
            placeId: "p1",
            name: "Corner Bar South",
            formattedAddress: "2190A Nolensville Pike",
            city: null,
            region: null,
            lat: 1,
            lng: 2,
            timezone: null,
            status: "ACTIVE",
            verificationStatus: "UNVERIFIED",
          },
        },
      },
    };
    expect(readExistingPlace(err)).toMatchObject({
      placeId: "p1",
      name: "Corner Bar South",
      lat: 1,
    });
    expect(readExistingPlace({ data: {} })).toBeNull();
  });

  it("reads the retry time from the rate-limit message", () => {
    const now = new Date("2026-10-14T15:00:00Z");
    expect(
      readRetryAt(
        { message: "Rate limit exceeded for adding places. Try again in 600s." },
        now,
      )?.toISOString(),
    ).toBe("2026-10-14T15:10:00.000Z");
    expect(readRetryAt({ message: "nope" }, now)).toBeNull();
  });

  it("maps an unknown editability reason to generic copy", () => {
    expect(toRefusalReason("CLAIM_PENDING")).toBe("CLAIM_PENDING");
    expect(toRefusalReason("DUPLICATE_ACTIVE")).toBe("NOT_ACTIVE");
    expect(toRefusalReason(null)).toBe("NOT_ACTIVE");
  });
});

describe("formatRetryIn", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  const after = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  it("says minutes, rounded up, under an hour", () => {
    expect(formatRetryIn(after(3412), now, "en")).toBe("in 57 minutes");
    expect(formatRetryIn(after(5), now, "en")).toBe("in 1 minute");
  });
  it("says hours from an hour on", () => {
    expect(formatRetryIn(after(3600), now, "en")).toBe("in 1 hour");
    // Rounds UP: 61 minutes must never read as "in 1 hour".
    expect(formatRetryIn(after(3601), now, "en")).toBe("in 2 hours");
  });
  it("speaks the locale", () => {
    expect(formatRetryIn(after(3412), now, "es")).toBe("dentro de 57 minutos");
  });
});
