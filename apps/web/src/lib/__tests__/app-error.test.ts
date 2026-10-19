import { describe, expect, it } from "vitest";

import { getAppErrorCode } from "../app-error";

describe("getAppErrorCode", () => {
  it("prefers the structured data.appCode", () => {
    const error = {
      message: "Paid tickets require a connected Stripe account.",
      data: { appCode: "PAID_TICKETING_REQUIRES_STRIPE" },
    };
    expect(getAppErrorCode(error)).toBe("PAID_TICKETING_REQUIRES_STRIPE");
  });

  it("normalizes a lowercase data.appCode to uppercase", () => {
    const error = { data: { appCode: "ticket_type_name_taken" } };
    expect(getAppErrorCode(error)).toBe("TICKET_TYPE_NAME_TAKEN");
  });

  it("falls back to a canonical-looking message when data.appCode is absent", () => {
    const error = { message: "PAID_TICKETING_REQUIRES_STRIPE" };
    expect(getAppErrorCode(error)).toBe("PAID_TICKETING_REQUIRES_STRIPE");
  });

  it("falls back to the message when data has no appCode", () => {
    const error = { message: "TICKET_TYPE_NAME_TAKEN", data: {} };
    expect(getAppErrorCode(error)).toBe("TICKET_TYPE_NAME_TAKEN");
  });

  it("maps a known legacy lowercase message to its canonical code", () => {
    // `quota_exceeded` is a legacy snake_case identifier still emitted by the
    // not-yet-migrated `enforceQuota` throw; it must resolve to canonical.
    const error = { message: "quota_exceeded" };
    expect(getAppErrorCode(error)).toBe("QUOTA_EXCEEDED");
  });

  it("maps a known legacy lowercase data.appCode to its canonical code", () => {
    const error = { data: { appCode: "paid_ticketing_requires_stripe" } };
    expect(getAppErrorCode(error)).toBe("PAID_TICKETING_REQUIRES_STRIPE");
  });

  it("returns null for an unknown lowercase token", () => {
    const error = { message: "totally_made_up_code" };
    expect(getAppErrorCode(error)).toBeNull();
  });

  it("returns null for a canonical-shaped but non-existent code", () => {
    // SCREAMING_SNAKE shape but not in the AppErrorCode registry — must not
    // pass through; the helper validates against the code Set.
    expect(getAppErrorCode({ message: "TOTALLY_FAKE_CODE" })).toBeNull();
    expect(getAppErrorCode({ data: { appCode: "SOME_FAKE_CODE" } })).toBeNull();
  });

  it("returns null for a human-readable sentence message", () => {
    const error = { message: "Something went wrong. Please try again." };
    expect(getAppErrorCode(error)).toBeNull();
  });

  it("ignores a blank data.appCode and falls back to the message", () => {
    const error = {
      message: "EVENT_PASSWORD_INVALID",
      data: { appCode: "  " },
    };
    expect(getAppErrorCode(error)).toBe("EVENT_PASSWORD_INVALID");
  });

  it("returns null for non-error input", () => {
    expect(getAppErrorCode(null)).toBeNull();
    expect(getAppErrorCode(undefined)).toBeNull();
    expect(getAppErrorCode("PAID_TICKETING_REQUIRES_STRIPE")).toBeNull();
    expect(getAppErrorCode(42)).toBeNull();
    expect(getAppErrorCode({})).toBeNull();
  });
});
