import { describe, expect, it, vi } from "vitest";

import {
  firstSignInInstant,
  stampFirstSignInFromHook,
  type FirstSignInStampDeps,
} from "../src/auth/first-sign-in";

const NOW = new Date("2026-10-07T17:00:00.000Z");

function makeDeps(overrides: Partial<FirstSignInStampDeps> = {}) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTime: vi.fn(),
    log: vi.fn(),
  } as unknown as FirstSignInStampDeps["logger"] & {
    error: ReturnType<typeof vi.fn>;
  };
  const stampIfUnset = vi.fn(async (_id: string, _at: Date) => {});
  const reportError = vi.fn();
  const deps = {
    stampIfUnset,
    logger,
    reportError,
    now: () => NOW,
    ...overrides,
  } satisfies FirstSignInStampDeps;
  return { deps, logger, stampIfUnset, reportError };
}

describe("firstSignInInstant", () => {
  it("uses the session's createdAt when it is a valid Date", () => {
    const at = new Date("2026-10-07T16:59:59.000Z");
    expect(firstSignInInstant(at, () => NOW)).toBe(at);
  });

  it.each([undefined, null, "2026-10-07", 0, new Date("nope")])(
    "falls back to the clock for %s",
    (value) => {
      expect(firstSignInInstant(value, () => NOW)).toBe(NOW);
    },
  );
});

describe("stampFirstSignInFromHook (session.create.after)", () => {
  it("a throwing logger changes nothing", async () => {
    const { deps, logger, reportError } = makeDeps({
      stampIfUnset: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    logger.error.mockImplementation(() => {
      throw new Error("logger down");
    });

    await expect(
      stampFirstSignInFromHook(deps, { authUserId: "au-4" }),
    ).resolves.toBe("failed");
    expect(reportError).toHaveBeenCalled();
  });

  it("stamps the AuthUser with the session's createdAt", async () => {
    const { deps, stampIfUnset, reportError } = makeDeps();
    const at = new Date("2026-10-07T16:00:00.000Z");

    await expect(
      stampFirstSignInFromHook(deps, {
        authUserId: "au-1",
        sessionCreatedAt: at,
      }),
    ).resolves.toBe("stamped");
    expect(stampIfUnset).toHaveBeenCalledWith("au-1", at);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("never throws on a failed write: logs at ERROR and reports", async () => {
    const boom = new Error("db down");
    const { deps, logger, reportError } = makeDeps({
      stampIfUnset: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(
      stampFirstSignInFromHook(deps, { authUserId: "au-2" }),
    ).resolves.toBe("failed");
    expect(logger.error).toHaveBeenCalledWith(
      "auth.first_sign_in.stamp_failed",
      expect.objectContaining({ authUserId: "au-2", err: boom }),
    );
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ op: "first_sign_in_stamp" }),
        extra: { authUserId: "au-2" },
      }),
    );
  });

  it("a reporter that throws changes nothing", async () => {
    const { deps } = makeDeps({
      stampIfUnset: vi.fn(async () => {
        throw new Error("db down");
      }),
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
    });

    await expect(
      stampFirstSignInFromHook(deps, { authUserId: "au-3" }),
    ).resolves.toBe("failed");
  });
});
