import { afterEach, describe, expect, it, vi } from "vitest";

import {
  notifyAuthInvalidated,
  subscribeAuthInvalidated,
} from "./auth-invalidation-bus";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("auth invalidation bus", () => {
  it("reports sync throws and continues notifying listeners", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];

    const unsubscribeThrowing = subscribeAuthInvalidated(() => {
      calls.push("throw");
      throw new Error("sync boom");
    });

    const unsubscribeHealthy = subscribeAuthInvalidated(() => {
      calls.push("healthy");
    });

    try {
      notifyAuthInvalidated();
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }

    expect(calls).toEqual(["throw", "healthy"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[scanner] auth-invalidation listener threw",
      expect.any(Error),
    );
  });

  it("reports async rejections and continues notifying listeners", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];

    const unsubscribeRejecting = subscribeAuthInvalidated(() => {
      calls.push("reject");
      return Promise.reject(new Error("async boom"));
    });

    const unsubscribeHealthy = subscribeAuthInvalidated(() => {
      calls.push("healthy");
    });

    try {
      notifyAuthInvalidated();
      await Promise.resolve();
    } finally {
      unsubscribeRejecting();
      unsubscribeHealthy();
    }

    expect(calls).toEqual(["reject", "healthy"]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[scanner] auth-invalidation listener rejected",
      expect.any(Error),
    );
  });
});
