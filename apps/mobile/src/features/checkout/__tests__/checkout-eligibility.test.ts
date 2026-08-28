import { describe, expect, it } from "vitest";

import {
  resolveCheckoutPath,
  type ResolveCheckoutPathInput,
} from "../checkout-eligibility";

/** Baseline: sellable GA event, no gate, no waiver → native. */
const nativeBase: ResolveCheckoutPathInput = {
  enableBuyTickets: true,
  sellabilityAvailable: true,
  gateType: "NONE",
  passwordRequired: false,
  viewerCanBypass: false,
  viewerIsUnlocked: false,
  placeLayoutId: null,
  hasWaiver: false,
};

describe("resolveCheckoutPath", () => {
  it("returns native for a sellable, ungated GA event without a waiver", () => {
    expect(resolveCheckoutPath(nativeBase)).toBe("native");
  });

  it("hides the CTA when the buyTickets feature gate is off", () => {
    expect(
      resolveCheckoutPath({ ...nativeBase, enableBuyTickets: false }),
    ).toBe("hidden");
  });

  it("hides the CTA when the event is not sellable", () => {
    expect(
      resolveCheckoutPath({ ...nativeBase, sellabilityAvailable: false }),
    ).toBe("hidden");
  });

  it("treats unknown sellability as non-blocking", () => {
    expect(
      resolveCheckoutPath({ ...nativeBase, sellabilityAvailable: null }),
    ).toBe("native");
  });

  describe("application gates", () => {
    const applicationLocked: ResolveCheckoutPathInput = {
      ...nativeBase,
      gateType: "APPLICATION",
      sellabilityAvailable: null, // ticket types are FORBIDDEN while locked
    };

    it("routes a locked application gate to web", () => {
      expect(resolveCheckoutPath(applicationLocked)).toBe("web");
    });

    it("allows native when the viewer can bypass the application gate", () => {
      expect(
        resolveCheckoutPath({
          ...applicationLocked,
          viewerCanBypass: true,
          sellabilityAvailable: true,
        }),
      ).toBe("native");
    });

    it("allows native when the viewer is unlocked for the application gate", () => {
      expect(
        resolveCheckoutPath({
          ...applicationLocked,
          viewerIsUnlocked: true,
          sellabilityAvailable: true,
        }),
      ).toBe("native");
    });
  });

  describe("password gates", () => {
    it("prompts for the password while the gate is locked", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "PASSWORD",
          passwordRequired: true,
          sellabilityAvailable: null,
        }),
      ).toBe("password");
    });

    it("allows native once the password gate is unlocked", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "PASSWORD",
          passwordRequired: false,
          viewerIsUnlocked: true,
        }),
      ).toBe("native");
    });

    it("allows native when the viewer bypasses the password gate", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "PASSWORD",
          passwordRequired: false,
          viewerCanBypass: true,
        }),
      ).toBe("native");
    });
  });

  it("routes reserved-seating events (placeLayoutId set) to web", () => {
    expect(
      resolveCheckoutPath({ ...nativeBase, placeLayoutId: "layout-1" }),
    ).toBe("web");
  });

  it("routes waiver-bearing events to web", () => {
    expect(resolveCheckoutPath({ ...nativeBase, hasWaiver: true })).toBe("web");
  });

  it("treats unknown waiver state as no waiver", () => {
    expect(resolveCheckoutPath({ ...nativeBase, hasWaiver: null })).toBe(
      "native",
    );
  });

  describe("rule precedence", () => {
    it("hidden (feature gate) wins over a locked password gate", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          enableBuyTickets: false,
          gateType: "PASSWORD",
          passwordRequired: true,
          sellabilityAvailable: null,
        }),
      ).toBe("hidden");
    });

    it("hidden (not sellable) wins over a locked application gate", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          sellabilityAvailable: false,
          gateType: "APPLICATION",
        }),
      ).toBe("hidden");
    });

    it("application gate wins over password rules and seating", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "APPLICATION",
          placeLayoutId: "layout-1",
          hasWaiver: true,
        }),
      ).toBe("web");
    });

    it("locked password gate wins over seating and waiver", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "PASSWORD",
          passwordRequired: true,
          placeLayoutId: "layout-1",
          hasWaiver: true,
        }),
      ).toBe("password");
    });

    it("seating wins over waiver (both resolve to web anyway)", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          placeLayoutId: "layout-1",
          hasWaiver: true,
        }),
      ).toBe("web");
    });

    it("an unlocked password gate with reserved seating still goes to web", () => {
      expect(
        resolveCheckoutPath({
          ...nativeBase,
          gateType: "PASSWORD",
          passwordRequired: false,
          viewerIsUnlocked: true,
          placeLayoutId: "layout-1",
        }),
      ).toBe("web");
    });
  });
});
