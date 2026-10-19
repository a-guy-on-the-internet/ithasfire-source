import { describe, expect, it } from "vitest";

import {
  isEmailVerificationRequired,
  nextVerificationLatch,
  retryUnlessVerificationRequired,
  shouldLogTrpcOperation,
} from "../email-verification-required";

/** What `TRPCClientError` carries for the B2 refusal: the generic FORBIDDEN
 * code, the domain code only in the message. */
const GATE = Object.assign(new Error("email_verification_required"), {
  data: { code: "FORBIDDEN", httpStatus: 403, appCode: "FORBIDDEN" },
  shape: { message: "email_verification_required", code: -32003 },
});

const OTHER_FORBIDDEN = Object.assign(new Error("forbidden"), {
  data: { code: "FORBIDDEN", httpStatus: 403, appCode: "FORBIDDEN" },
});

describe("isEmailVerificationRequired", () => {
  it("matches the server's refusal by its message", () => {
    expect(isEmailVerificationRequired(GATE)).toBe(true);
  });

  it("matches the raw use-case shape and a future appCode", () => {
    expect(
      isEmailVerificationRequired({
        code: "forbidden",
        message: "email_verification_required",
      }),
    ).toBe(true);
    expect(
      isEmailVerificationRequired({
        message: "Forbidden",
        data: { appCode: "EMAIL_VERIFICATION_REQUIRED" },
      }),
    ).toBe(true);
  });

  it("does not match other FORBIDDEN errors, network errors or nothing", () => {
    expect(isEmailVerificationRequired(OTHER_FORBIDDEN)).toBe(false);
    expect(isEmailVerificationRequired(new Error("Network request failed"))).toBe(
      false,
    );
    expect(isEmailVerificationRequired(null)).toBe(false);
    expect(isEmailVerificationRequired(undefined)).toBe(false);
    expect(isEmailVerificationRequired("email_verification_required")).toBe(false);
  });
});

describe("retryUnlessVerificationRequired", () => {
  it("never retries the gate", () => {
    expect(retryUnlessVerificationRequired(1)(0, GATE)).toBe(false);
  });

  it("retries anything else up to the limit", () => {
    const retry = retryUnlessVerificationRequired(1);
    expect(retry(0, new Error("Network request failed"))).toBe(true);
    expect(retry(1, new Error("Network request failed"))).toBe(false);
  });
});

describe("nextVerificationLatch", () => {
  const gated = { gated: true, answered: true };
  const pending = { gated: false, answered: false };
  const answered = { gated: false, answered: true };

  it("holds the prompt through a foreground refetch of the gated query", () => {
    // error → pending (React Query clears `error` while it refetches a query
    // with no data) → error again. The prompt, and the code typed into it,
    // must survive the pending frame.
    let latched = nextVerificationLatch(false, gated);
    expect(latched).toBe(true);
    latched = nextVerificationLatch(latched, pending);
    expect(latched).toBe(true);
    latched = nextVerificationLatch(latched, gated);
    expect(latched).toBe(true);
  });

  it("lets go when the query answers otherwise (a success after a verify, or a network error)", () => {
    let latched = nextVerificationLatch(false, gated);
    latched = nextVerificationLatch(latched, pending);
    latched = nextVerificationLatch(latched, answered);
    expect(latched).toBe(false);
  });

  it("stays off for a query that was never gated", () => {
    expect(nextVerificationLatch(false, pending)).toBe(false);
    expect(nextVerificationLatch(false, answered)).toBe(false);
  });
});

describe("shouldLogTrpcOperation", () => {
  it("skips the gate refusal coming back", () => {
    expect(shouldLogTrpcOperation({ direction: "down", result: GATE })).toBe(false);
  });

  it("logs every request going up", () => {
    expect(shouldLogTrpcOperation({ direction: "up" })).toBe(true);
  });

  it("logs a successful result and any other error", () => {
    expect(
      shouldLogTrpcOperation({ direction: "down", result: { result: { data: [] } } }),
    ).toBe(true);
    expect(
      shouldLogTrpcOperation({ direction: "down", result: new Error("FORBIDDEN") }),
    ).toBe(true);
  });
});
