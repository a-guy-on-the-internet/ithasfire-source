import { describe, expect, it, vi } from "vitest";

import { safeReporter, type ReporterPort } from "../src/reporter";

/**
 * The `ReporterPort` docblock has always promised that "a throwing
 * implementation must never change caller behaviour" — but nothing enforced it.
 * The composition roots wired `Sentry.captureException` raw, and ~20 use cases
 * invoke it as a bare `deps.reportError?.(err, …)` inside a catch. A throwing
 * reporter therefore escaped the swallow branch and became the caller's
 * failure; on the checkout path that surfaced to the buyer as
 * `dependency_failed`, i.e. reporting a swallowed error manufactured a new one.
 *
 * These tests pin the wrapper that makes the promise structurally true.
 */
describe("safeReporter", () => {
  it("forwards the error and context untouched when the reporter behaves", () => {
    const inner = vi.fn();
    const err = new Error("boom");
    const context = { tags: { area: "checkout" }, extra: { orderId: "o1" } };

    safeReporter(inner)(err, context);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(err, context);
  });

  it("swallows a throwing reporter instead of propagating to the caller", () => {
    const inner: ReporterPort = () => {
      throw new Error("sentry is down");
    };

    // The assertion IS the behaviour: without the wrapper this call throws and
    // the caller's swallow branch becomes a failure.
    expect(() => safeReporter(inner)(new Error("original"))).not.toThrow();
  });

  it("keeps a caller's catch-and-fallback intact when the reporter throws", () => {
    const inner: ReporterPort = () => {
      throw new Error("sentry is down");
    };
    const report = safeReporter(inner);

    // Mirrors the real shape of a use-case swallow: do work, fail, report the
    // failure, return a degraded result. The fallback must still be returned.
    const runDegradableWork = (): string => {
      try {
        throw new Error("upstream failed");
      } catch (err) {
        report(err, { tags: { step: "reserveFeeWaiver" } });
        return "fallback";
      }
    };

    expect(runDegradableWork()).toBe("fallback");
  });

  it("swallows non-Error throws too (a reporter may throw anything)", () => {
    const inner: ReporterPort = () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "string throw";
    };

    expect(() => safeReporter(inner)(new Error("original"))).not.toThrow();
  });

  it("is re-entrant safe: each call is independently guarded", () => {
    let calls = 0;
    const inner: ReporterPort = () => {
      calls += 1;
      throw new Error("always throws");
    };
    const report = safeReporter(inner);

    expect(() => {
      report(new Error("one"));
      report(new Error("two"));
    }).not.toThrow();
    expect(calls).toBe(2);
  });
});
