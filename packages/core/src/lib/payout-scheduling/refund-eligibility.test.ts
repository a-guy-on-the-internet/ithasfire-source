import { describe, expect, it } from "vitest";

import {
  checkRefundEligibility,
  getInstantRefundCutoff,
  isInstantRefundAvailable,
} from "./refund-eligibility";

describe("checkRefundEligibility", () => {
  // Event starts at 8:00 PM CST on January 15, 2025
  const eventStart = new Date("2025-01-15T20:00:00-06:00");

  describe("when not paid out", () => {
    it("returns instant refund eligible well before event", () => {
      // 24 hours before event
      const now = new Date("2025-01-14T20:00:00-06:00");
      const result = checkRefundEligibility(eventStart, null, now);
      expect(result).toEqual({ eligible: true, type: "instant" });
    });

    it("returns instant refund eligible up to 4 hours before", () => {
      // 4 hours and 1 minute before event (still eligible)
      const now = new Date("2025-01-15T15:59:00-06:00");
      const result = checkRefundEligibility(eventStart, null, now);
      expect(result).toEqual({ eligible: true, type: "instant" });
    });

    it("returns organizer_only within 4 hours of event start", () => {
      // Exactly 4 hours before event
      const now = new Date("2025-01-15T16:00:00-06:00");
      const result = checkRefundEligibility(eventStart, null, now);
      expect(result).toEqual({ eligible: true, type: "organizer_only" });
    });

    it("returns organizer_only 1 hour before event", () => {
      const now = new Date("2025-01-15T19:00:00-06:00");
      const result = checkRefundEligibility(eventStart, null, now);
      expect(result).toEqual({ eligible: true, type: "organizer_only" });
    });

    it("returns not eligible after event starts", () => {
      // 1 minute after event starts
      const now = new Date("2025-01-15T20:01:00-06:00");
      const result = checkRefundEligibility(eventStart, null, now);
      expect(result).toEqual({ eligible: false, reason: "event_started" });
    });

    it("returns not eligible exactly at event start", () => {
      const result = checkRefundEligibility(eventStart, null, eventStart);
      expect(result).toEqual({ eligible: false, reason: "event_started" });
    });
  });

  describe("when already paid out", () => {
    it("returns not eligible regardless of timing", () => {
      // Even if we're way before the event, if paid out, no refund
      const paidOutAt = new Date("2025-01-10T12:00:00-06:00");
      const now = new Date("2025-01-14T12:00:00-06:00");
      const result = checkRefundEligibility(eventStart, paidOutAt, now);
      expect(result).toEqual({ eligible: false, reason: "already_paid_out" });
    });
  });
});

describe("getInstantRefundCutoff", () => {
  it("returns 4 hours before event start", () => {
    const eventStart = new Date("2025-01-15T20:00:00-06:00");
    const cutoff = getInstantRefundCutoff(eventStart);
    // 4 PM CST = 10 PM UTC
    expect(cutoff.toISOString()).toBe("2025-01-15T22:00:00.000Z");
  });
});

describe("isInstantRefundAvailable", () => {
  const eventStart = new Date("2025-01-15T20:00:00-06:00");

  it("returns true when well before cutoff", () => {
    const now = new Date("2025-01-14T12:00:00-06:00");
    expect(isInstantRefundAvailable(eventStart, now)).toBe(true);
  });

  it("returns false within cutoff window", () => {
    const now = new Date("2025-01-15T17:00:00-06:00");
    expect(isInstantRefundAvailable(eventStart, now)).toBe(false);
  });

  it("returns false after event starts", () => {
    const now = new Date("2025-01-15T21:00:00-06:00");
    expect(isInstantRefundAvailable(eventStart, now)).toBe(false);
  });
});
