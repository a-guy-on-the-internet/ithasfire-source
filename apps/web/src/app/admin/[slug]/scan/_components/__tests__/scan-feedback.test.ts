/**
 * The vibration signatures, and the guarantee that a browser without the
 * Vibration API (every iPhone) degrades quietly rather than throwing inside the
 * admission hot loop.
 *
 * The verdict FILLS collapsed to two; these did not. The suite asserts that
 * directly, because the reason is the whole argument: in a dark room the haptic
 * is the only channel left that separates "seen this pass" from "wrong show".
 */
import { SCAN_VERDICT_KEYS, SCAN_VERDICTS, type ScanVerdictKey } from "@th/types";
import { describe, expect, it, vi } from "vitest";

import {
  SCAN_VIBRATION_PATTERNS,
  VERDICT_FEEDBACK,
  scanFeedbackKind,
  vibrateForVerdict,
} from "../scan-feedback";

const KINDS = Object.keys(SCAN_VIBRATION_PATTERNS) as Array<
  keyof typeof SCAN_VIBRATION_PATTERNS
>;

describe("scan vibration signatures", () => {
  it("gives every signature its own pattern", () => {
    const seen = new Set(
      KINDS.map((k) => JSON.stringify(SCAN_VIBRATION_PATTERNS[k])),
    );
    // In the dark, "seen this pass" must not feel like "wrong show".
    expect(seen.size).toBe(KINDS.length);
  });

  it("keeps FOUR signatures under a TWO-tone visual system", () => {
    // Two tones and four haptics is deliberate, not leftover: the fills no
    // longer separate "already used" from "wrong event", so the haptic must.
    expect(KINDS).toHaveLength(4);
    expect(new Set(Object.values(SCAN_VERDICTS).map((v) => v.tone)).size).toBe(2);
  });

  it("maps EVERY shared verdict key to a signature", () => {
    // A key added to `@th/types` without a signature would silently fall
    // through to `undefined` and vibrate nothing.
    for (const key of SCAN_VERDICT_KEYS) {
      expect(SCAN_VIBRATION_PATTERNS[scanFeedbackKind(key)]).toBeDefined();
    }
    expect(Object.keys(VERDICT_FEEDBACK).sort()).toEqual(
      [...SCAN_VERDICT_KEYS].sort(),
    );
  });

  it("never feels like a pass when the verdict is a fail", () => {
    // The one cross-check between the two channels: the confirm buzz is
    // reserved for `pass`, so nobody can be waved through on a fail.
    for (const key of SCAN_VERDICT_KEYS) {
      const isPass = SCAN_VERDICTS[key].tone === "pass";
      expect(
        scanFeedbackKind(key) === "valid",
        `${key} (${SCAN_VERDICTS[key].tone}) → ${scanFeedbackKind(key)}`,
      ).toBe(isPass);
    }
  });

  it("keeps every pulse in a range a phone can actually render", () => {
    for (const kind of KINDS) {
      for (const ms of SCAN_VIBRATION_PATTERNS[kind]) {
        expect(ms).toBeGreaterThanOrEqual(15);
        expect(ms).toBeLessThanOrEqual(200);
      }
    }
  });

  it("fires the verdict's pattern when the API is present", () => {
    const vibrate = vi.fn(() => true);
    expect(vibrateForVerdict("invalid", { navigatorRef: { vibrate } })).toBe(
      "vibrated",
    );
    expect(vibrate).toHaveBeenCalledWith(SCAN_VIBRATION_PATTERNS.rejected);
  });

  it("is a quiet no-op where the API does not exist (iOS Safari)", () => {
    expect(vibrateForVerdict("valid", { navigatorRef: null })).toBe(
      "unsupported",
    );
    expect(vibrateForVerdict("valid", { navigatorRef: {} })).toBe("unsupported");
  });

  it("REPORTS a throwing API instead of swallowing it (NFR-006)", () => {
    const reportError = vi.fn();
    const boom = new Error("vibrate blocked");
    const outcome = vibrateForVerdict("alreadyUsed", {
      navigatorRef: {
        vibrate: () => {
          throw boom;
        },
      },
      reportError,
    });
    expect(outcome).toBe("failed");
    expect(reportError).toHaveBeenCalledWith(boom);
  });

  it("never lets a throwing API break the caller, reporter or not", () => {
    expect(() =>
      vibrateForVerdict("wrongEvent" satisfies ScanVerdictKey, {
        navigatorRef: {
          vibrate: () => {
            throw new Error("nope");
          },
        },
      }),
    ).not.toThrow();
  });
});
