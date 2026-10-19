import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../obfuscation-key";
import {
  LOCATION_OBFUSCATION_CANARY_EVENT,
  LOCATION_OBFUSCATION_CANARY_PLACE,
  LocationObfuscationSelfTestError,
  canaryPoint,
  verifyLocationObfuscationLive,
} from "../obfuscation-self-test";
import { projectPublicEventLocation } from "../project-public-event-location";
import { redactPlaceLocation } from "../redact-place-location";

const TEST_SECRET = "test-only-location-obfuscation-secret";

const canaries = [
  {
    source: "project-public-event-location",
    draw: () =>
      canaryPoint(projectPublicEventLocation(LOCATION_OBFUSCATION_CANARY_EVENT)),
  },
  {
    source: "redact-place-location",
    draw: () => canaryPoint(redactPlaceLocation(LOCATION_OBFUSCATION_CANARY_PLACE)),
  },
];

afterEach(() => {
  configureLocationObfuscation({ secret: TEST_SECRET });
});

describe("verifyLocationObfuscationLive — the boot self-test", () => {
  it("passes — and logs ONE pass line naming every canary — when the read paths draw circles", () => {
    const logger = { error: vi.fn(), info: vi.fn() };
    const reportError = vi.fn();
    expect(
      verifyLocationObfuscationLive({ canaries, failHard: true, logger, reportError }),
    ).toEqual({ ok: true, failed: [] });
    expect(logger.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("location_obfuscation.self_test_passed", {
      canaries: ["project-public-event-location", "redact-place-location"],
    });
  });

  it("PRODUCTION: a keyless module refuses to boot, naming every dead path", () => {
    resetLocationObfuscationForTests();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        verifyLocationObfuscationLive({ canaries, failHard: true }),
      ).toThrow(LocationObfuscationSelfTestError);
      try {
        verifyLocationObfuscationLive({ canaries, failHard: true });
      } catch (error) {
        expect((error as LocationObfuscationSelfTestError).failed).toEqual([
          "project-public-event-location",
          "redact-place-location",
        ]);
      }
    } finally {
      quiet.mockRestore();
    }
  });

  it("the TWO-COPIES failure: the root's copy is keyed, the read path's is not → caught", () => {
    // The root configured its copy (the package setup file keyed it); a
    // second, keyless copy of the module — simulated by a canary whose draw
    // comes back empty — is exactly what the check exists for.
    const keyless = { source: "@th/adapters/geo/obfuscation", draw: () => null };
    expect(() =>
      verifyLocationObfuscationLive({ canaries: [...canaries, keyless], failHard: true }),
    ).toThrow(/@th\/adapters\/geo\/obfuscation/);
  });

  it("DEV: logs an error and reports instead of throwing — a throwing reporter changes nothing", () => {
    resetLocationObfuscationForTests();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = { error: vi.fn() };
      const reportError = vi.fn(() => {
        throw new Error("sentry down");
      });
      expect(
        verifyLocationObfuscationLive({ canaries, failHard: false, logger, reportError }),
      ).toEqual({
        ok: false,
        failed: ["project-public-event-location", "redact-place-location"],
      });
      expect(logger.error).toHaveBeenCalledWith(
        "location_obfuscation.self_test_failed",
        expect.objectContaining({
          failed: ["project-public-event-location", "redact-place-location"],
        }),
      );
      expect(reportError).toHaveBeenCalledTimes(1);
    } finally {
      quiet.mockRestore();
    }
  });

  it("a canary that THROWS counts as dead, not as a crash", () => {
    const exploding = {
      source: "exploding",
      draw: () => {
        throw new Error("boom");
      },
    };
    expect(
      verifyLocationObfuscationLive({ canaries: [exploding], failHard: false }),
    ).toEqual({ ok: false, failed: ["exploding"] });
  });
});
