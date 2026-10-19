import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThrottledReporter } from "../throttled-reporter";

describe("createThrottledReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the first failure immediately", () => {
    const reportError = vi.fn();
    const throttled = createThrottledReporter(reportError, 15 * 60 * 1000);
    const error = new Error("redis down");

    throttled(error, { tags: { area: "test" }, extra: { key: "abc" } });

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(error, {
      tags: { area: "test" },
      extra: { key: "abc" },
    });
  });

  it("suppresses subsequent calls with the same tags inside the window", () => {
    const reportError = vi.fn();
    const throttled = createThrottledReporter(reportError, 15 * 60 * 1000);

    throttled(new Error("first"), { tags: { area: "test" } });
    vi.advanceTimersByTime(5 * 60 * 1000); // 5 minutes later, still inside window
    throttled(new Error("second"), { tags: { area: "test" } });
    throttled(new Error("third"), { tags: { area: "test" } });

    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("reports again once the window has elapsed", () => {
    const reportError = vi.fn();
    const throttled = createThrottledReporter(reportError, 15 * 60 * 1000);

    throttled(new Error("first"), { tags: { area: "test" } });
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    throttled(new Error("second"), { tags: { area: "test" } });

    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("throttles distinct tag-keys independently (a Redis outage must not mask a rate-limiter-backend outage or vice versa)", () => {
    const reportError = vi.fn();
    const throttled = createThrottledReporter(reportError, 15 * 60 * 1000);

    throttled(new Error("get failed"), {
      tags: { area: "auth_rate_limit_fail_open", branch: "get" },
    });
    throttled(new Error("set failed"), {
      tags: { area: "auth_rate_limit_fail_open", branch: "set" },
    });
    // Same key as the first call, still inside the window — suppressed.
    throttled(new Error("get failed again"), {
      tags: { area: "auth_rate_limit_fail_open", branch: "get" },
    });

    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("no-ops without throwing when no reportError is wired", () => {
    const throttled = createThrottledReporter(undefined, 15 * 60 * 1000);

    expect(() =>
      throttled(new Error("boom"), { tags: { area: "test" } }),
    ).not.toThrow();
  });

  it("treats calls with no tags as sharing one key", () => {
    const reportError = vi.fn();
    const throttled = createThrottledReporter(reportError, 15 * 60 * 1000);

    throttled(new Error("first"));
    throttled(new Error("second"));

    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
