import { describe, it, expect } from "vitest";
import { ZodError, ZodIssueCode } from "zod";

import {
  AppError,
  normalizeError,
  formatAuthErrorMessage,
  isWebAuthnCancel,
  NETWORK_ERROR_MESSAGE,
} from "../index";

describe("normalizeError", () => {
  // ── 1. null / undefined → EMPTY ─────────────────────────────────────
  it("returns empty object for null", () => {
    expect(normalizeError(null)).toEqual({
      fieldErrors: {},
      formError: null,
      code: null,
    });
  });

  it("returns empty object for undefined", () => {
    expect(normalizeError(undefined)).toEqual({
      fieldErrors: {},
      formError: null,
      code: null,
    });
  });

  // ── 2. ZodError with field paths → fieldErrors, no formError ────────
  it("converts ZodError with field paths into fieldErrors", () => {
    const zodError = new ZodError([
      {
        code: ZodIssueCode.too_small,
        minimum: 1,
        type: "string",
        inclusive: true,
        message: "Name is required",
        path: ["name"],
      },
      {
        code: ZodIssueCode.invalid_type,
        expected: "string",
        received: "undefined",
        message: "Email is required",
        path: ["email"],
      },
    ]);

    const result = normalizeError(zodError);
    expect(result.fieldErrors).toEqual({
      name: "Name is required",
      email: "Email is required",
    });
    expect(result.formError).toBeNull();
    expect(result.code).toBeNull();
  });

  // ── 3. ZodError with multiple errors on same field → first only ─────
  it("keeps only the first error per field", () => {
    const zodError = new ZodError([
      {
        code: ZodIssueCode.too_small,
        minimum: 1,
        type: "string",
        inclusive: true,
        message: "Too short",
        path: ["password"],
      },
      {
        code: ZodIssueCode.too_small,
        minimum: 8,
        type: "string",
        inclusive: true,
        message: "Must be at least 8 characters",
        path: ["password"],
      },
    ]);

    const result = normalizeError(zodError);
    expect(result.fieldErrors).toEqual({ password: "Too short" });
  });

  // ── 4. tRPC error with .data.zodError.fieldErrors → field-level ─────
  it("extracts field errors from tRPC zodError shape", () => {
    const trpcError = {
      message: "Input validation failed",
      data: {
        code: "BAD_REQUEST",
        zodError: {
          fieldErrors: {
            title: ["Title is required"],
            date: ["Invalid date", "Date must be in the future"],
          },
          formErrors: [],
        },
      },
    };

    const result = normalizeError(trpcError);
    expect(result.fieldErrors).toEqual({
      title: "Title is required",
      date: "Invalid date",
    });
    expect(result.formError).toBeNull();
    // BAD_REQUEST is a transport HTTP code, not an AppErrorCode → null.
    expect(result.code).toBeNull();
  });

  // ── 5. tRPC error without zodError → .message as formError ──────────
  it("uses message as formError for tRPC error without zodError", () => {
    const trpcError = {
      message: "Something broke on the server",
      data: { code: "INTERNAL_SERVER_ERROR" },
    };

    const result = normalizeError(trpcError);
    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe("Something broke on the server");
    // INTERNAL_SERVER_ERROR is not an AppErrorCode → null.
    expect(result.code).toBeNull();
  });

  // ── 6. Object with .message that's a snake_case code → humanized ────
  it("humanizes a snake_case message", () => {
    const result = normalizeError({ message: "event_not_found" });
    expect(result.formError).toBe(
      "Event not found. Please try again or contact support.",
    );
  });

  // ── 7. Object with .message that's already a sentence → as-is ───────
  it("returns a sentence message as-is", () => {
    const result = normalizeError({
      message: "This event has already ended.",
    });
    expect(result.formError).toBe("This event has already ended.");
  });

  // ── 8. Plain string → used as formError ─────────────────────────────
  it("uses a plain string as formError", () => {
    const result = normalizeError("something_went_wrong");
    expect(result.fieldErrors).toEqual({});
    expect(result.formError).toBe(
      "Something went wrong. Please try again or contact support.",
    );
    expect(result.code).toBeNull();
  });

  it("uses a sentence string as formError unchanged", () => {
    const result = normalizeError("Payment failed unexpectedly.");
    expect(result.formError).toBe("Payment failed unexpectedly.");
  });

  // ── 9. Auth rewrite: "Unauthorized" → friendly message ─────────────
  it('rewrites "Unauthorized" to a friendly credentials message', () => {
    const result = normalizeError("Unauthorized");
    expect(result.formError).toBe(
      "Invalid email or password. Please try again.",
    );
  });

  // ── 10. Auth rewrite: "invalid credentials" ─────────────────────────
  it('rewrites "invalid credentials" to a friendly credentials message', () => {
    const result = normalizeError({ message: "invalid credentials" });
    expect(result.formError).toBe(
      "Invalid email or password. Please try again.",
    );
  });

  // ── 11. "Invalid date format" is NOT rewritten ──────────────────────
  it('does NOT rewrite "Invalid date format" as an auth error', () => {
    const result = normalizeError({ message: "Invalid date format" });
    expect(result.formError).toBe("Invalid date format");
  });

  it('does NOT rewrite "Invalid event ID" as an auth error', () => {
    const result = normalizeError({ message: "Invalid event ID" });
    expect(result.formError).toBe("Invalid event ID");
  });

  // ── Network / fetch failures → friendly NETWORK_ERROR_MESSAGE ───────
  it('rewrites Safari\'s "Load failed" into the network message', () => {
    const result = normalizeError(new TypeError("Load failed"));
    expect(result.formError).toBe(NETWORK_ERROR_MESSAGE);
    expect(result.code).toBe("NETWORK");
  });

  it('rewrites Chrome\'s "Failed to fetch" into the network message', () => {
    const result = normalizeError({ message: "Failed to fetch" });
    expect(result.formError).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("treats a nested Better Auth error message as a network failure", () => {
    const result = normalizeError({ error: { message: "Load failed" } });
    expect(result.formError).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("treats status === 0 as a network failure", () => {
    const result = normalizeError({ status: 0, message: "" });
    expect(result.formError).toBe(NETWORK_ERROR_MESSAGE);
  });

  it("does NOT treat a 4xx with a real message as a network failure", () => {
    const result = normalizeError({
      status: 400,
      message: "Invalid email or password.",
    });
    expect(result.formError).not.toBe(NETWORK_ERROR_MESSAGE);
  });

  // ── 12. With t function: resolves errors.camelCaseKey ───────────────
  it("resolves i18n key via t function when translation is available", () => {
    const t = (key: string) => {
      const translations: Record<string, string> = {
        "errors.eventNotFound": "We couldn't find that event.",
      };
      return translations[key] ?? key;
    };

    const result = normalizeError("event_not_found", t);
    expect(result.formError).toBe("We couldn't find that event.");
    expect(result.code).toBe("EVENT_NOT_FOUND");
  });

  it("still resolves a non-union copy key (e.g. title_required) via t on the fallback path", () => {
    // `TITLE_REQUIRED` was removed from the throwable union, but pure UI copy
    // must still resolve through `t("errors.*")` since the fallback path keys
    // off the raw string, not union membership.
    const t = (key: string) =>
      key === "errors.titleRequired" ? "A title is required." : key;
    const result = normalizeError("title_required", t);
    expect(result.formError).toBe("A title is required.");
    // Not a union member → no structured code.
    expect(result.code).toBeNull();
  });

  it("falls back to humanized text when t function returns the key", () => {
    const t = (key: string) => key;
    const result = normalizeError("ticket_type_not_found", t);
    expect(result.formError).toBe(
      "Ticket type not found. Please try again or contact support.",
    );
  });

  // ── Structured AppErrorCode (preferred) ─────────────────────────────
  it("prefers a structured tRPC data.appCode over message parsing", () => {
    const t = (key: string) =>
      key === "errors.eventNotFound" ? "We couldn't find that event." : key;
    const result = normalizeError(
      { message: "event_not_found", data: { appCode: "EVENT_NOT_FOUND" } },
      t,
    );
    expect(result.code).toBe("EVENT_NOT_FOUND");
    expect(result.formError).toBe("We couldn't find that event.");
  });

  // ── Better Auth shapes ──────────────────────────────────────────────
  it("maps EMAIL_NOT_VERIFIED code to that AppErrorCode", () => {
    const result = normalizeError({
      code: "EMAIL_NOT_VERIFIED",
      message: "Email not verified",
    });
    expect(result.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("does NOT map a bare 403 with a non-auth message to EMAIL_NOT_VERIFIED", () => {
    const result = normalizeError({
      status: 403,
      message: "Insufficient role",
    });
    expect(result.code).not.toBe("EMAIL_NOT_VERIFIED");
    expect(result.code).toBe("FORBIDDEN");
  });

  it("still maps a 403 carrying a verify-email message to EMAIL_NOT_VERIFIED", () => {
    const result = normalizeError({
      status: 403,
      message: "Please verify your email before signing in",
    });
    expect(result.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("maps a verify-email message to EMAIL_NOT_VERIFIED", () => {
    const result = normalizeError({
      message: "Please verify your email to continue",
    });
    expect(result.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("maps USER_ALREADY_EXISTS code to that AppErrorCode", () => {
    const result = normalizeError({
      code: "USER_ALREADY_EXISTS",
      message: "nope",
    });
    expect(result.code).toBe("USER_ALREADY_EXISTS");
  });

  it("maps an already-registered message to USER_ALREADY_EXISTS", () => {
    const result = normalizeError({
      message: "An account with that email already exists",
    });
    expect(result.code).toBe("USER_ALREADY_EXISTS");
  });

  it("maps the USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL variant via the code prefix (not the message)", () => {
    // Better Auth's sign-up path emits this variant code; routing must not
    // depend on its English message copy.
    const result = normalizeError({
      code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
      message: "totally unrelated copy",
    });
    expect(result.code).toBe("USER_ALREADY_EXISTS");
  });

  // ── No raw provider/host leakage (NFR-002) ──────────────────────────
  it("never leaks a raw host string for an unknown error object", () => {
    const result = normalizeError({});
    expect(result.formError).toBe("Something went wrong. Please try again.");
    expect(result.code).toBeNull();
  });
});

describe("formatAuthErrorMessage", () => {
  it("returns the resolved form error", () => {
    expect(formatAuthErrorMessage("Unauthorized")).toBe(
      "Invalid email or password. Please try again.",
    );
  });

  it("returns the generic default when nothing resolves", () => {
    expect(formatAuthErrorMessage(null)).toBe(
      "We couldn't complete that action. Double-check your details and try again.",
    );
  });
});

describe("isWebAuthnCancel", () => {
  it("returns true for a NotAllowedError DOMException", () => {
    const err = new DOMException("The operation was cancelled", "NotAllowedError");
    expect(isWebAuthnCancel(err)).toBe(true);
  });

  it("returns true when the message contains 'cancel'", () => {
    expect(isWebAuthnCancel(new Error("User cancelled the ceremony"))).toBe(
      true,
    );
  });

  it("returns false for a generic error", () => {
    expect(isWebAuthnCancel(new Error("Something else"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isWebAuthnCancel(null)).toBe(false);
  });
});

describe("normalizeError — no meta.reason override (ABSORB removed)", () => {
  // `fee_mode_absorb` used to swap in "platform setup issue" copy for the
  // publish and paid-ticket ABSORB refusals. Both refusals are gone
  // (docs/decisions/absorb-removed.md), and so is the override: a stale
  // reason on an old error reads exactly like the bare code.
  it("a FEE_POLICY_NOT_ACTIVE with reason fee_mode_absorb gets the code's own copy", () => {
    const withReason = {
      data: {
        appCode: "FEE_POLICY_NOT_ACTIVE",
        meta: { reason: "fee_mode_absorb" },
      },
    };
    const bare = { data: { appCode: "FEE_POLICY_NOT_ACTIVE" } };
    expect(normalizeError(withReason).formError).toBe(
      normalizeError(bare).formError,
    );
    expect(normalizeError(withReason).code).toBe("FEE_POLICY_NOT_ACTIVE");
  });
});
