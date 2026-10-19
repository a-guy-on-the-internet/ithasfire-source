import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/react-native", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  addBreadcrumb: vi.fn(),
}));

import { reportPosIssue, reportRetentionIssue } from "./report";

beforeEach(() => {
  captureException.mockReset();
});

describe("reportPosIssue", () => {
  it("captures with the pos feature, branch, order and the caller's tags", () => {
    const error = new Error("Tap to Pay connect failed: X");
    reportPosIssue(error, {
      branch: "tap_to_pay_sdk_error",
      orderId: "ord_1",
      tags: { step: "connect", phase: "before-confirm", code: "X" },
      extra: { nativeErrorCode: "2020" },
    });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: {
        feature: "pos",
        branch: "tap_to_pay_sdk_error",
        orderId: "ord_1",
        step: "connect",
        phase: "before-confirm",
        code: "X",
      },
      extra: { nativeErrorCode: "2020" },
    });
  });

  it("passes a warning level through, and leaves Sentry's default otherwise", () => {
    reportPosIssue(new Error("declined"), {
      branch: "b",
      orderId: "ord_1",
      level: "warning",
    });
    expect(captureException.mock.calls[0]![1]).toMatchObject({ level: "warning" });
    reportPosIssue(new Error("x"), { branch: "b", orderId: "ord_1" });
    expect(captureException.mock.calls[1]![1]).not.toHaveProperty("level");
  });

  it("never throws when Sentry does", () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    expect(() =>
      reportPosIssue(new Error("x"), { branch: "b", orderId: "ord_1" }),
    ).not.toThrow();
  });
});

describe("reportRetentionIssue", () => {
  it("captures with the retention feature and the step", () => {
    const error = new Error("no such table: people_fts");
    reportRetentionIssue(error, {
      branch: "event_list_people_drop",
      extra: { listedEvents: 3 },
    });
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { feature: "pii_retention", branch: "event_list_people_drop" },
      extra: { listedEvents: 3 },
    });
  });

  it("never throws when Sentry does", () => {
    captureException.mockImplementation(() => {
      throw new Error("sentry down");
    });
    expect(() =>
      reportRetentionIssue(new Error("x"), { branch: "b" }),
    ).not.toThrow();
  });
});
