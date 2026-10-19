import { describe, expect, it, vi } from "vitest";

import { createSystemClock } from "../clock";

describe("createSystemClock", () => {
  it("returns current time based on Date.now by default", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const clock = createSystemClock();
    const result = clock.now();

    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(1_700_000_000_000);

    nowSpy.mockRestore();
  });

  it("supports custom now providers that return Date instances", () => {
    const reference = new Date("2025-01-02T03:04:05.678Z");
    const clock = createSystemClock({ nowProvider: () => reference });

    const first = clock.now();
    expect(first).not.toBe(reference);
    expect(first.getTime()).toBe(reference.getTime());
  });

  it("throws when the provider returns an invalid value", () => {
    const clock = createSystemClock({ nowProvider: () => Number.NaN });

    expect(() => clock.now()).toThrow(/invalid date/i);
  });
});
