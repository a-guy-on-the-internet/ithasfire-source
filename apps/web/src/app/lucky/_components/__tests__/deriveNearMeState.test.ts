import { describe, expect, it } from "vitest";

import { deriveNearMeState } from "../SurpriseMe";

// These tests lock in the toggle-abort + honest-denied behavior from the
// design review: the CTA must only be held while actively locating, never on a
// denied prompt, and the hint must state plainly when a roll will ignore the
// requested location.
describe("deriveNearMeState", () => {
  it("is fully open when near-me is off", () => {
    const state = deriveNearMeState({
      nearMe: false,
      hasCoords: false,
      locating: false,
      hasError: false,
    });
    expect(state.waiting).toBe(false);
    expect(state.blocked).toBe(false);
    expect(state.hint).toMatch(/anywhere/i);
  });

  it("holds the CTA only while actively locating (no coords yet)", () => {
    const state = deriveNearMeState({
      nearMe: true,
      hasCoords: false,
      locating: true,
      hasError: false,
    });
    expect(state.waiting).toBe(true);
    expect(state.blocked).toBe(false);
    expect(state.hint).toMatch(/getting your location/i);
  });

  it("un-gates the moment near-me is toggled off mid-lookup", () => {
    // Same geolocation status as the waiting case, but the toggle is now off —
    // the user aborted, so nothing should gate the CTA.
    const state = deriveNearMeState({
      nearMe: false,
      hasCoords: false,
      locating: true,
      hasError: false,
    });
    expect(state.waiting).toBe(false);
    expect(state.blocked).toBe(false);
  });

  it("does not gate once coordinates arrive", () => {
    const state = deriveNearMeState({
      nearMe: true,
      hasCoords: true,
      locating: false,
      hasError: false,
    });
    expect(state.waiting).toBe(false);
    expect(state.blocked).toBe(false);
    expect(state.hint).toMatch(/near your current location/i);
  });

  it("is honest (not waiting) when permission is denied", () => {
    const state = deriveNearMeState({
      nearMe: true,
      hasCoords: false,
      locating: false,
      hasError: true,
    });
    // Crucially NOT waiting — the CTA stays usable — but flagged blocked and the
    // hint says the roll will ignore Near me.
    expect(state.waiting).toBe(false);
    expect(state.blocked).toBe(true);
    expect(state.hint).toMatch(/ignore Near me/i);
  });

  it("prefers the locating hint over an error while a retry is in flight", () => {
    const state = deriveNearMeState({
      nearMe: true,
      hasCoords: false,
      locating: true,
      hasError: true,
    });
    expect(state.waiting).toBe(true);
    expect(state.blocked).toBe(false);
    expect(state.hint).toMatch(/getting your location/i);
  });
});
