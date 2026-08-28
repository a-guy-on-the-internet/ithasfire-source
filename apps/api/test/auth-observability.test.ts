import { describe, expect, it, vi } from "vitest";

import {
  logAuthUserSignedUp,
  logAuthVerificationEmailSent,
} from "../src/auth/observability";

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

describe("auth observability", () => {
  it("logs signup success as structured info only", () => {
    const logger = makeLogger();

    logAuthUserSignedUp({
      logger: logger as any,
      authUserId: "auth-user-1",
      maskedEmail: "s***w@e***e.com",
      hasDisplayName: true,
    });

    expect(logger.info).toHaveBeenCalledWith("auth_user_signed_up", {
      authUserId: "auth-user-1",
      maskedEmail: "s***w@e***e.com",
      hasDisplayName: true,
    });
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs verification email success as structured info only", () => {
    const logger = makeLogger();

    logAuthVerificationEmailSent({
      logger: logger as any,
      authUserId: "auth-user-2",
      maskedEmail: "v***r@e***e.com",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "auth_email_verification_send_completed",
      {
        authUserId: "auth-user-2",
        maskedEmail: "v***r@e***e.com",
      },
    );
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
