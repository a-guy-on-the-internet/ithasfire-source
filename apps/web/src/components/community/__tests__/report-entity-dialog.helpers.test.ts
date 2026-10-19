import { describe, expect, it } from "vitest";

import {
  isRateLimitedError,
  isReportAlreadyOpenError,
  isSelectionKey,
  isUnauthorizedError,
  nextReasonForKey,
  reportReasonOptionDomId,
  type EntityReportReason,
} from "../report-entity-dialog.helpers";

const ORDER: readonly EntityReportReason[] = [
  "CLOSED_OR_GONE",
  "INCORRECT_INFO",
  "DUPLICATE",
  "INAPPROPRIATE",
  "SPAM",
  "OTHER",
];

describe("nextReasonForKey", () => {
  it("moves forward on ArrowDown/ArrowRight and wraps at the end", () => {
    expect(nextReasonForKey("CLOSED_OR_GONE", "ArrowDown", ORDER)).toBe(
      "INCORRECT_INFO",
    );
    expect(nextReasonForKey("CLOSED_OR_GONE", "ArrowRight", ORDER)).toBe(
      "INCORRECT_INFO",
    );
    expect(nextReasonForKey("OTHER", "ArrowDown", ORDER)).toBe(
      "CLOSED_OR_GONE",
    );
  });

  it("moves backward on ArrowUp/ArrowLeft and wraps at the start", () => {
    expect(nextReasonForKey("INCORRECT_INFO", "ArrowUp", ORDER)).toBe(
      "CLOSED_OR_GONE",
    );
    expect(nextReasonForKey("CLOSED_OR_GONE", "ArrowLeft", ORDER)).toBe(
      "OTHER",
    );
  });

  it("supports Home and End", () => {
    expect(nextReasonForKey("SPAM", "Home", ORDER)).toBe("CLOSED_OR_GONE");
    expect(nextReasonForKey("SPAM", "End", ORDER)).toBe("OTHER");
  });

  it("enters at the ends when nothing is selected yet", () => {
    expect(nextReasonForKey(null, "ArrowDown", ORDER)).toBe("CLOSED_OR_GONE");
    expect(nextReasonForKey(null, "ArrowUp", ORDER)).toBe("OTHER");
    expect(nextReasonForKey(null, "Home", ORDER)).toBe("CLOSED_OR_GONE");
    expect(nextReasonForKey(null, "End", ORDER)).toBe("OTHER");
  });

  it("returns null for keys the group does not handle (never trap Tab)", () => {
    expect(nextReasonForKey("SPAM", "Tab", ORDER)).toBeNull();
    expect(nextReasonForKey("SPAM", "Enter", ORDER)).toBeNull();
    expect(nextReasonForKey(null, "Tab", ORDER)).toBeNull();
    expect(nextReasonForKey("SPAM", "a", ORDER)).toBeNull();
  });

  it("handles an empty order and an unknown current value", () => {
    expect(nextReasonForKey(null, "ArrowDown", [])).toBeNull();
    expect(nextReasonForKey("IMPERSONATION", "ArrowDown", ORDER)).toBeNull();
  });
});

describe("isSelectionKey", () => {
  it("selects on Space and Enter", () => {
    expect(isSelectionKey(" ")).toBe(true);
    expect(isSelectionKey("Spacebar")).toBe(true);
    expect(isSelectionKey("Enter")).toBe(true);
    expect(isSelectionKey("ArrowDown")).toBe(false);
    expect(isSelectionKey("Tab")).toBe(false);
  });
});

describe("reportReasonOptionDomId", () => {
  it("is stable per reason", () => {
    expect(reportReasonOptionDomId("SPAM")).toBe("report-entity-reason-SPAM");
  });
});

describe("error discriminators", () => {
  it("matches the dedupe CONFLICT by its legacy message", () => {
    expect(isReportAlreadyOpenError(new Error("report_already_open"))).toBe(
      true,
    );
    expect(isReportAlreadyOpenError(new Error("CONFLICT"))).toBe(false);
    expect(isReportAlreadyOpenError(null)).toBe(false);
  });

  it("matches rate limiting via the tRPC data.code channel", () => {
    expect(
      isRateLimitedError({ data: { code: "TOO_MANY_REQUESTS" } }),
    ).toBe(true);
    expect(isRateLimitedError({ data: { code: "UNAUTHORIZED" } })).toBe(false);
    expect(isRateLimitedError(new Error("TOO_MANY_REQUESTS"))).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
  });

  it("matches UNAUTHORIZED via the tRPC data.code channel", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED" } })).toBe(true);
    expect(isUnauthorizedError({ data: { code: "FORBIDDEN" } })).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });
});
