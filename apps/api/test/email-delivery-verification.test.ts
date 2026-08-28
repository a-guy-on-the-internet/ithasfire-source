import { describe, expect, it, vi } from "vitest";

import type { EmailDeliveryVerificationDeps } from "../src/auth/email-delivery-verification";
import { clearEmailDeliveryStatusAfterVerification } from "../src/auth/email-delivery-verification";

function makeLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeDeps(
  overrides: Partial<EmailDeliveryVerificationDeps> = {},
): EmailDeliveryVerificationDeps {
  return {
    deliverability: {
      clearByEmail: vi.fn().mockResolvedValue(true),
    },
    logger: makeLogger(),
    ...overrides,
  } as EmailDeliveryVerificationDeps;
}

describe("clearEmailDeliveryStatusAfterVerification", () => {
  it("clears the normalized verified email", async () => {
    const deps = makeDeps();

    const result = await clearEmailDeliveryStatusAfterVerification(deps, {
      id: "auth-user-1",
      email: "  Person@Example.COM ",
    });

    expect(deps.deliverability.clearByEmail).toHaveBeenCalledWith(
      "person@example.com",
    );
    expect(result).toEqual({
      outcome: "cleared",
      email: "person@example.com",
      matched: true,
    });
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it("skips users without an email", async () => {
    const deps = makeDeps();

    const result = await clearEmailDeliveryStatusAfterVerification(deps, {
      id: "auth-user-2",
    });

    expect(result).toEqual({ outcome: "skipped_missing_email" });
    expect(deps.deliverability.clearByEmail).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "auth_email_delivery_clear_skipped",
      {
        reason: "missing_email",
        authUserId: "auth-user-2",
      },
    );
  });

  it("handles adapter failures without breaking verification", async () => {
    const error = new Error("database unavailable");
    const deps = makeDeps({
      deliverability: {
        clearByEmail: vi.fn().mockRejectedValue(error),
      },
    });

    const result = await clearEmailDeliveryStatusAfterVerification(deps, {
      id: "auth-user-3",
      email: "verified@example.com",
    });

    expect(result).toEqual({
      outcome: "failed",
      email: "verified@example.com",
      error,
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "auth_email_delivery_clear_failed",
      {
        authUserId: "auth-user-3",
        error,
      },
    );
  });
});