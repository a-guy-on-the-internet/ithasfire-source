import { describe, expect, it } from "vitest";

import { bookingPreferredDateSchema } from "./pitch-schema";

// `preferredDates` widened from a bare date to an optional wall-clock time so
// the picker can carry "Sat 22 Aug, 8pm". Storage and every downstream reader
// stay on plain strings, so rows written before times existed must still pass.

describe("bookingPreferredDateSchema", () => {
  it("accepts a bare date — the shape every existing row uses", () => {
    expect(bookingPreferredDateSchema.parse("2026-08-22")).toBe("2026-08-22");
  });

  it("accepts a date with a wall-clock time", () => {
    expect(bookingPreferredDateSchema.parse("2026-08-22T20:30")).toBe(
      "2026-08-22T20:30",
    );
    expect(bookingPreferredDateSchema.parse("2026-08-22T00:00")).toBe(
      "2026-08-22T00:00",
    );
    expect(bookingPreferredDateSchema.parse("2026-08-22T23:59")).toBe(
      "2026-08-22T23:59",
    );
  });

  it("rejects an impossible calendar date", () => {
    expect(() => bookingPreferredDateSchema.parse("2026-02-31")).toThrow();
    expect(() => bookingPreferredDateSchema.parse("2026-13-01")).toThrow();
  });

  it("rejects an impossible clock time", () => {
    expect(() => bookingPreferredDateSchema.parse("2026-08-22T24:00")).toThrow();
    expect(() => bookingPreferredDateSchema.parse("2026-08-22T19:60")).toThrow();
  });

  it("rejects an offset or a zone — the frame is the venue's local time", () => {
    // Pinning an instant here would be silently wrong the next time DST moves.
    expect(() =>
      bookingPreferredDateSchema.parse("2026-08-22T20:00:00Z"),
    ).toThrow();
    expect(() =>
      bookingPreferredDateSchema.parse("2026-08-22T20:00-05:00"),
    ).toThrow();
  });

  it("rejects loose formats", () => {
    expect(() => bookingPreferredDateSchema.parse("08/22/2026")).toThrow();
    expect(() => bookingPreferredDateSchema.parse("2026-8-2")).toThrow();
    expect(() => bookingPreferredDateSchema.parse("")).toThrow();
  });
});
