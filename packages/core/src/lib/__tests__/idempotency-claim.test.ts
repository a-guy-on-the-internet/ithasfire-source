import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { abandonClaim, isDeterministicRejection } from "../idempotency-claim";

describe("isDeterministicRejection", () => {
  it("is true for boundary parse failures only", () => {
    expect(isDeterministicRejection({ code: "invalid_input", message: "invalid_input" })).toBe(true);
    const zodErr = z.object({ a: z.string() }).safeParse({}).error!;
    expect(isDeterministicRejection(zodErr)).toBe(true);
    // Structural: a zod error from ANOTHER zod copy still counts.
    expect(isDeterministicRejection({ issues: [{ path: ["a"], message: "x" }] })).toBe(true);
    expect(isDeterministicRejection(new Error("db_unavailable"))).toBe(false);
    expect(isDeterministicRejection({ code: "dependency_failed" })).toBe(false);
    expect(isDeterministicRejection({ code: "ORDER_NOT_FOUND" })).toBe(false);
    expect(isDeterministicRejection(null)).toBe(false);
  });
});

describe("abandonClaim", () => {
  it("releases the claim (owner-checked) on a transient error so a retry can begin immediately", async () => {
    const idem = createFakeIdempotencyPort();
    await idem.begin("k", 60, "owner-1");

    const outcome = await abandonClaim(idem, "k", "owner-1", new Error("db down"), {
      useCase: "test",
    });

    expect(outcome).toBe("released");
    expect(idem.__mocks.fail).not.toHaveBeenCalled();
    expect(idem.__mocks.release).toHaveBeenCalledWith("k", "owner-1");
    // Immediately re-acquirable — no 15-minute failed marker.
    expect(await idem.begin("k", 60, "owner-2")).toBe(true);
  });

  it("writes the failed marker on a deterministic rejection", async () => {
    const idem = createFakeIdempotencyPort();
    await idem.begin("k", 60, "owner-1");

    const outcome = await abandonClaim(
      idem,
      "k",
      "owner-1",
      { code: "invalid_input", message: "invalid_input" },
      { useCase: "test" },
    );

    expect(outcome).toBe("failed");
    expect(idem.__mocks.fail).toHaveBeenCalledWith("k", expect.any(String));
    expect(idem.__mocks.release).not.toHaveBeenCalled();
  });

  it("a lost lock never frees another holder's claim, and is error-logged + reported", async () => {
    const idem = createFakeIdempotencyPort();
    await idem.begin("k", 60, "owner-2");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const reportError = vi.fn();

    expect(
      await abandonClaim(idem, "k", "stale-owner", new Error("x"), {
        useCase: "finalizePaymentIntent",
        logger: logger as never,
        reportError,
      }),
    ).toBe("lost");
    expect(idem.__tokens.get("k")).toBe("owner-2");
    expect(logger.error).toHaveBeenCalledWith(
      "idempotency_claim_lost_on_abandon",
      expect.objectContaining({ key: "k" }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "idempotency_claim_lost_on_abandon" }),
      {
        tags: { useCase: "finalizePaymentIntent", stage: "idempotency_claim_lost_on_abandon" },
        extra: { key: "k" },
      },
    );
  });

  it("a failing release is error-logged + reported and never throws; fail is not written", async () => {
    const idem = createFakeIdempotencyPort();
    await idem.begin("k", 60, "owner-2");
    const logger = { warn: vi.fn(), error: vi.fn() };
    const reportError = vi.fn();
    idem.__mocks.release.mockRejectedValueOnce(new Error("redis gone"));

    expect(
      await abandonClaim(idem, "k", "owner-2", new Error("x"), {
        useCase: "test",
        logger: logger as never,
        reportError,
      }),
    ).toBe("release_error");
    expect(idem.__mocks.fail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "idempotency_claim_release_failed",
      expect.objectContaining({ key: "k", error: "redis gone" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "redis gone" }),
      expect.objectContaining({
        tags: { useCase: "test", stage: "idempotency_claim_release_failed" },
      }),
    );
  });

  it("a throwing logger or reporter cannot escape the cleanup", async () => {
    const idem = createFakeIdempotencyPort();
    await idem.begin("k", 60, "owner-2");
    const logger = {
      error: vi.fn(() => {
        throw new Error("logger down");
      }),
    };
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    await expect(
      abandonClaim(idem, "k", "stale-owner", new Error("x"), {
        useCase: "test",
        logger: logger as never,
        reportError,
      }),
    ).resolves.toBe("lost");
  });
});
