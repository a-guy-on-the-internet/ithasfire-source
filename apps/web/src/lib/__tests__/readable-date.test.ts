import { describe, expect, it } from "vitest";
import { readableDateIso, readableIso } from "../readable-date";

describe("readableIso", () => {
  it("keeps a readable ISO string as given", () => {
    expect(readableIso("2027-01-01T18:00:00.000Z")).toBe(
      "2027-01-01T18:00:00.000Z",
    );
  });

  it.each([undefined, null, "", "not-a-date", "2027-13-45T99:00:00Z"])(
    "treats %j as absent",
    (value) => {
      expect(readableIso(value)).toBeUndefined();
    },
  );
});

describe("readableDateIso", () => {
  it("serialises a valid Date", () => {
    expect(readableDateIso(new Date("2027-01-01T18:00:00.000Z"))).toBe(
      "2027-01-01T18:00:00.000Z",
    );
  });

  it.each([undefined, null, new Date("not-a-date")])(
    "returns undefined for %j instead of throwing",
    (value) => {
      expect(readableDateIso(value)).toBeUndefined();
    },
  );
});
