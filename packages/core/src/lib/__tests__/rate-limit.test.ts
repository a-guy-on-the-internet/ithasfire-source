import { describe, it, expect } from "vitest";
import { enforceCooldown } from "../rate-limit";

describe("enforceCooldown", () => {
  const baseInput = {
    cooldownSeconds: 300,
    actionDescription: "sending another announcement to this audience",
  };

  function clockAt(iso: string) {
    return { now: () => new Date(iso) };
  }

  it("does nothing when lastActionAt is null", () => {
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:00:00Z"),
        lastActionAt: null,
      }),
    ).not.toThrow();
  });

  it("does nothing when lastActionAt is undefined", () => {
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:00:00Z"),
        lastActionAt: undefined,
      }),
    ).not.toThrow();
  });

  it("does nothing when enough time has elapsed", () => {
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:10:00Z"), // 600s elapsed
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
      }),
    ).not.toThrow();
  });

  it("does nothing when exactly the cooldown has elapsed", () => {
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:05:00Z"), // exactly 300s
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
      }),
    ).not.toThrow();
  });

  it("throws rate_limited when cooldown has not elapsed", () => {
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:02:00Z"), // 120s elapsed, 180s remaining
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "rate_limited",
        message:
          "Please wait 180 seconds before sending another announcement to this audience",
      }),
    );
  });

  it("throws rate_limited when 1 second remains", () => {
    // 299s elapsed → 1s remaining
    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock: clockAt("2026-03-11T12:04:59Z"),
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "rate_limited",
        message:
          "Please wait 1 seconds before sending another announcement to this audience",
      }),
    );
  });

  it("uses the action description in the error message", () => {
    expect(() =>
      enforceCooldown({
        clock: clockAt("2026-03-11T12:00:30Z"), // 30s elapsed
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
        cooldownSeconds: 60,
        actionDescription: "creating another waitlist entry",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "rate_limited",
        message:
          "Please wait 30 seconds before creating another waitlist entry",
      }),
    );
  });

  it("ceils the remaining seconds", () => {
    // 298.5s elapsed → 1.5s remaining → ceil to 2
    const clock = { now: () => new Date("2026-03-11T12:04:58.500Z") };

    expect(() =>
      enforceCooldown({
        ...baseInput,
        clock,
        lastActionAt: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "rate_limited",
        message:
          "Please wait 2 seconds before sending another announcement to this audience",
      }),
    );
  });
});
