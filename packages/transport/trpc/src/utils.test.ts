import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { TRPCError } from "@trpc/server";
import { AppError, fail, fromLegacyCode } from "@th/errors";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "@th/core/lib/payments/chargeback-terms";

import {
  appCodeToTrpc,
  errorCodeMap,
  isInternalAppCode,
  META_FREE_APP_CODES,
  readCuratedDomainMeta,
  readDomainMeta,
  resolveWireAppCode,
  toTrpcError,
} from "./utils";

/**
 * Reproduces the router's initTRPC `errorFormatter` (see trpc.ts) so the wire
 * `data` shape is asserted directly: it must preserve tRPC's own fields
 * (`...shape.data`) and add `meta`/`appCode` only when present.
 */
const formatWireData = (
  shapeData: Record<string, unknown>,
  error: unknown,
): Record<string, unknown> => {
  const meta = readDomainMeta(error);
  const appCode = resolveWireAppCode(error);
  return {
    ...shapeData,
    ...(meta ? { meta } : {}),
    ...(appCode ? { appCode } : {}),
  };
};

const metaOf = (err: TRPCError): Record<string, unknown> | undefined =>
  (err as TRPCError & { meta?: Record<string, unknown> }).meta;

describe("toTrpcError", () => {
  it.each([
    ["performer_mode_required", "PRECONDITION_FAILED"],
    ["place_not_accepting_requests", "PRECONDITION_FAILED"],
    ["place_not_verified", "PRECONDITION_FAILED"],
    ["duplicate_open_request", "CONFLICT"],
    ["invalid_status", "CONFLICT"],
  ] as const)("maps %s → %s", (code, trpcCode) => {
    const err = toTrpcError({ code, message: code });
    expect(err).toBeInstanceOf(TRPCError);
    expect(err.code).toBe(trpcCode);
    expect(err.message).toBe(code);
  });

  it("maps the booking_request_expired message under invalid_status to CONFLICT", () => {
    const err = toTrpcError({
      code: "invalid_status",
      message: "booking_request_expired",
    });
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("booking_request_expired");
  });

  // Codes previously missing from `errorCodeMap` whose domain code sits in the
  // `code` field — each used to fall through to INTERNAL_SERVER_ERROR (500),
  // polluting the Sentry/500 stream and sending the wrong status to clients.
  it.each([
    // Transport category + auth boundary.
    ["precondition_failed", "PRECONDITION_FAILED"],
    ["unauthorized", "UNAUTHORIZED"],
    ["unauthenticated", "UNAUTHORIZED"],
    // Resale / claims domain codes.
    ["listing_not_found", "NOT_FOUND"],
    ["not_ticket_owner", "FORBIDDEN"],
    ["cannot_buy_own_listing", "FORBIDDEN"],
    ["claim_not_respondent", "FORBIDDEN"],
    ["invalid_argument", "BAD_REQUEST"],
    ["invalid_order_item", "BAD_REQUEST"],
    ["claim_not_resale_order", "BAD_REQUEST"],
    ["resale_price_exceeds_cap", "BAD_REQUEST"],
    ["resale_not_enabled", "PRECONDITION_FAILED"],
    ["resale_not_allowed_for_type", "PRECONDITION_FAILED"],
    ["seller_payout_not_setup", "PRECONDITION_FAILED"],
    ["claim_window_not_open", "PRECONDITION_FAILED"],
    ["listing_not_active", "CONFLICT"],
    ["listing_already_held", "CONFLICT"],
    ["ticket_not_eligible_for_resale", "CONFLICT"],
    ["sale_cutoff_passed", "CONFLICT"],
    ["claim_window_expired", "CONFLICT"],
    ["claim_response_deadline_passed", "CONFLICT"],
    ["claim_already_exists", "CONFLICT"],
    ["claim_already_resolved", "CONFLICT"],
  ] as const)("maps newly-mapped %s → %s (was 500)", (code, trpcCode) => {
    const err = toTrpcError({ code, message: code });
    expect(err.code).toBe(trpcCode);
    expect(err.code).not.toBe("INTERNAL_SERVER_ERROR");
    // Wire-compat: message is left exactly as thrown.
    expect(err.message).toBe(code);
  });

  it("maps the unauthorized authn-adapter error to UNAUTHORIZED with a human message", () => {
    // The real Better Auth adapter throws { code: "unauthorized", message:
    // "Token invalid or expired" } — the domain code is in `code`, free text in
    // `message`. Status must be 401; message is preserved untouched.
    const err = toTrpcError({
      code: "unauthorized",
      message: "Token invalid or expired",
    });
    expect(err.code).toBe("UNAUTHORIZED");
    expect(err.message).toBe("Token invalid or expired");
  });

  it("keeps genuinely-internal codes at INTERNAL_SERVER_ERROR", () => {
    for (const code of [
      "db_error",
      "redis_down",
      "internal",
      "internal_error",
      "service_unavailable",
      "dependency_failed",
    ]) {
      expect(toTrpcError({ code, message: code }).code).toBe(
        "INTERNAL_SERVER_ERROR",
      );
    }
  });

  it("falls through to INTERNAL_SERVER_ERROR for unknown codes", () => {
    const err = toTrpcError({ code: "totally_unknown_code" });
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("maps a bare ZodError to a clean INTERNAL_SERVER_ERROR without leaking raw issues", () => {
    const zodErr = new ZodError([
      {
        code: "invalid_type",
        expected: "string",
        path: ["id"],
        message: "Expected string, received number",
      } as never,
    ]);
    const err = toTrpcError(zodErr);
    expect(err.code).toBe("INTERNAL_SERVER_ERROR");
    // Wire-facing message must be clean, never the raw issue dump.
    expect(err.message).toBe("Internal validation error");
    expect(err.message).not.toContain("invalid_type");
    // The real ZodError detail must still be reachable off `cause` for
    // Sentry/logging. Note: zod v4's classic `ZodError` does not itself
    // extend the native `Error`, so `TRPCError`'s own constructor (which
    // normalizes non-`Error` causes via `Object.assign(new
    // UnknownCauseError(), cause)`) copies its enumerable `message` (the
    // raw issue JSON) onto a new cause object rather than preserving the
    // original reference — hence asserting on the copied `.message`
    // instead of reference equality.
    expect(err.cause).toBeDefined();
    expect((err.cause as Error).message).toContain("invalid_type");
  });

  it("preserves the use-case cause chain", () => {
    const cause = new Error("db exploded");
    const err = toTrpcError({
      code: "duplicate_open_request",
      message: "duplicate_open_request",
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  describe("appCode resolution", () => {
    it("resolves appCode from the snake_case message and stashes it on meta", () => {
      const err = toTrpcError({ code: "not_found", message: "event_not_found" });
      expect(err.code).toBe("NOT_FOUND");
      // Backwards-compatible: message stays snake_case.
      expect(err.message).toBe("event_not_found");
      expect(metaOf(err)?.appCode).toBe("EVENT_NOT_FOUND");
    });

    it("resolves appCode from the code field when it is itself the domain code", () => {
      const err = toTrpcError({
        code: "event_already_has_agreement",
        message: "An agreement already exists for this event.",
      });
      expect(err.code).toBe("CONFLICT");
      expect(metaOf(err)?.appCode).toBe("EVENT_ALREADY_HAS_AGREEMENT");
    });

    it("uses an AppError instance's own code", () => {
      const err = toTrpcError(
        new AppError("ORDER_NOT_REFUNDABLE", {
          message: "order_not_refundable",
        }),
      );
      expect(metaOf(err)?.appCode).toBe("ORDER_NOT_REFUNDABLE");
    });
  });

  describe("AppError → tRPC code", () => {
    it.each([
      ["EVENT_NOT_FOUND", "NOT_FOUND"],
      ["ORDER_NOT_REFUNDABLE", "CONFLICT"],
      // Status-hardening (deliberate): "Stripe not connected" is a precondition
      // for the action, not a state conflict — 412. (Was 409 during the codemod
      // to preserve the legacy wire status; now corrected.)
      ["STRIPE_NOT_CONNECTED", "PRECONDITION_FAILED"],
      ["NON_POSITIVE_AMOUNT", "BAD_REQUEST"],
      ["QUOTA_EXCEEDED", "FORBIDDEN"],
      // Ban that sticks (owner ruling 2026-10-07): a refused NEW shift claim
      // on a withheld owner's ask is a state conflict, never a 404.
      ["SHIFT_SIGNUPS_PAUSED", "CONFLICT"],
      // Staff-side twin (owner ruling 2026-10-08): approving or assigning a
      // NEW volunteer on a withheld owner's ask or event.
      ["VOLUNTEER_APPROVALS_PAUSED", "CONFLICT"],
    ] as const)(
      "resolves a thrown AppError(%s) → %s with data.appCode",
      (appCode, trpcCode) => {
        let caught: unknown;
        try {
          fail(appCode);
        } catch (e) {
          caught = e;
        }
        const err = toTrpcError(caught);
        expect(err).toBeInstanceOf(TRPCError);
        expect(err.code).toBe(trpcCode);
        expect(metaOf(err)?.appCode).toBe(appCode);
      },
    );

    it("sends SHIFT_SIGNUPS_PAUSED as the bare code (the web catalog keys on it) with no meta beyond appCode", () => {
      let caught: unknown;
      try {
        fail("SHIFT_SIGNUPS_PAUSED");
      } catch (e) {
        caught = e;
      }
      const err = toTrpcError(caught);
      expect(err.message).toBe("SHIFT_SIGNUPS_PAUSED");
      expect(metaOf(err)).toEqual({ appCode: "SHIFT_SIGNUPS_PAUSED" });
    });

    it("sends VOLUNTEER_APPROVALS_PAUSED as the bare code (the web catalog keys on it) with no meta beyond appCode", () => {
      let caught: unknown;
      try {
        fail("VOLUNTEER_APPROVALS_PAUSED");
      } catch (e) {
        caught = e;
      }
      const err = toTrpcError(caught);
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toBe("VOLUNTEER_APPROVALS_PAUSED");
      expect(metaOf(err)).toEqual({ appCode: "VOLUNTEER_APPROVALS_PAUSED" });
    });

    it("borrows the category hint's bucket when provided", () => {
      // EVENT_NOT_FOUND would default to NOT_FOUND; the category overrides it.
      const err = toTrpcError(
        new AppError("EVENT_NOT_FOUND", { category: "CONFLICT" }),
      );
      expect(err.code).toBe("CONFLICT");
      expect(metaOf(err)?.appCode).toBe("EVENT_NOT_FOUND");
    });

    it("merges AppError meta with the resolved appCode", () => {
      const err = toTrpcError(
        new AppError("QUOTA_EXCEEDED", {
          meta: { kind: "events", limitValue: 5 },
        }),
      );
      expect(err.code).toBe("FORBIDDEN");
      expect(metaOf(err)).toEqual({
        kind: "events",
        limitValue: 5,
        appCode: "QUOTA_EXCEEDED",
      });
    });

    it("preserves an AppError cause for Sentry's linkedErrors", () => {
      const cause = new Error("db exploded");
      const err = toTrpcError(new AppError("SEAT_UNAVAILABLE", { cause }));
      expect(err.code).toBe("CONFLICT");
      expect(err.cause).toBe(cause);
    });

    it("merges existing domain meta with the resolved appCode", () => {
      const err = toTrpcError({
        code: "attestation_incomplete",
        message: "attestation_incomplete",
        meta: { missingFields: ["alcoholCompliance"] },
      });
      expect(metaOf(err)).toEqual({
        missingFields: ["alcoholCompliance"],
        appCode: "ATTESTATION_INCOMPLETE",
      });
    });

    it("forwards chargeback_terms_required owner + requiredVersion to the wire via meta", () => {
      // Mirrors the object thrown by `throwChargebackTermsRequired` in
      // @th/core lib/payments/chargeback-terms.ts. Only `meta` survives
      // `toTrpcError`, so the acceptance UI can read who must accept and
      // which version — the top-level copies are dropped on the wire.
      const owner = { type: "ORGANIZATION", id: "org-1" } as const;
      const thrown = {
        code: "chargeback_terms_required",
        message: "chargeback_terms_required",
        requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
        owner,
        meta: { owner, requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION },
      };
      const err = toTrpcError(thrown);
      expect(err.code).toBe("PRECONDITION_FAILED");
      expect(err.message).toBe("chargeback_terms_required");
      expect(metaOf(err)).toMatchObject({
        owner,
        requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      });

      const wire = formatWireData({ code: "PRECONDITION_FAILED" }, err);
      expect(wire.meta).toMatchObject({
        owner,
        requiredVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
      });
      expect(wire).not.toHaveProperty("owner");
      expect(wire).not.toHaveProperty("requiredVersion");
    });

    it("leaves meta undefined for an unmapped code with no domain meta", () => {
      const err = toTrpcError({ code: "totally_unknown_code" });
      expect(err.code).toBe("INTERNAL_SERVER_ERROR");
      expect(metaOf(err)).toBeUndefined();
    });

    it("keeps the SDK cause chain while stashing appCode on meta", () => {
      const cause = new Error("db exploded");
      const err = toTrpcError({
        code: "not_found",
        message: "event_not_found",
        cause,
      });
      // Cause chain for Sentry is untouched...
      expect(err.cause).toBe(cause);
      // ...and appCode rides on meta instead.
      expect(metaOf(err)?.appCode).toBe("EVENT_NOT_FOUND");
    });
  });
});

describe("wire errorFormatter (readDomainMeta + resolveWireAppCode)", () => {
  const baseShapeData = { code: -32600, httpStatus: 404, path: "some.path" };

  it("surfaces data.meta and data.appCode for a legacy toTrpcError result", () => {
    const err = toTrpcError({ code: "not_found", message: "event_not_found" });
    const data = formatWireData(baseShapeData, err);
    // tRPC's own fields are preserved untouched.
    expect(data.code).toBe(-32600);
    expect(data.httpStatus).toBe(404);
    expect(data.path).toBe("some.path");
    // Domain channel added.
    expect(data.appCode).toBe("EVENT_NOT_FOUND");
    expect(data.meta).toEqual({ appCode: "EVENT_NOT_FOUND" });
  });

  it("surfaces reason+fields meta for EDIT_SUGGESTION_INVALID_FIELDS (the propose-edits bug)", () => {
    let caught: unknown;
    try {
      fail("EDIT_SUGGESTION_INVALID_FIELDS", {
        meta: { fields: ["content"], reason: "invalid_body" },
      });
    } catch (e) {
      caught = e;
    }
    const err = toTrpcError(caught);
    const data = formatWireData(baseShapeData, err);
    expect(data.appCode).toBe("EDIT_SUGGESTION_INVALID_FIELDS");
    expect(data.meta).toEqual({
      fields: ["content"],
      reason: "invalid_body",
      appCode: "EDIT_SUGGESTION_INVALID_FIELDS",
    });
  });

  it("reads meta off .cause.meta for direct TRPCErrors that carry it there", () => {
    const cause = { meta: { appCode: "SEAT_UNAVAILABLE", reason: "held" } };
    const trpcError = new TRPCError({
      code: "CONFLICT",
      message: "nope",
      cause,
    });
    expect(readDomainMeta(trpcError)).toEqual({
      appCode: "SEAT_UNAVAILABLE",
      reason: "held",
    });
    expect(resolveWireAppCode(trpcError)).toBe("SEAT_UNAVAILABLE");
  });

  it("omits meta and appCode for a Zod-style input error with no domain code", () => {
    // BAD_REQUEST with a ZodError cause never went through toTrpcError, so it
    // carries no `.meta` / domain code — the formatter must add nothing.
    const err = new TRPCError({
      code: "BAD_REQUEST",
      message: "Invalid input",
      cause: new ZodError([]),
    });
    const data = formatWireData(baseShapeData, err);
    expect(readDomainMeta(err)).toBeUndefined();
    expect(resolveWireAppCode(err)).toBeNull();
    expect("meta" in data).toBe(false);
    expect("appCode" in data).toBe(false);
  });
});

// booking-the-night FR-001: the sender's refusal must never carry another
// party's hold id or position (booking-holds FR-013). Structural: whatever a
// thrower attaches, only `appCode` reaches the wire.
describe("META_FREE_APP_CODES (NIGHT_NO_LONGER_AVAILABLE)", () => {
  const baseShapeData = { code: -32603, httpStatus: 409, path: "bookingAgreements.respond" };
  const LEAK = {
    aheadHoldId: "00000000-0000-4000-8000-0000000000aa",
    position: 1,
    date: "2026-10-17",
  };

  it("lists every sender-side refusal and NONE of the venue-side codes", () => {
    for (const code of [
      "NIGHT_NO_LONGER_AVAILABLE",
      "BOOKING_ALREADY_HAS_NIGHT",
      "TERMS_CHANGED_SINCE_VIEWED",
      "EVENT_ON_ANOTHER_NIGHT",
      "EVENT_FIRST_ORIGIN_GONE",
      "LINKED_EVENT_NOT_LIVE",
      "PLACE_NOT_TAKING_BOOKINGS",
      // booking-the-night P2c
      "BOOKING_CANCELLED",
      "BOOKING_NIGHT_BOOKED",
    ] as const) {
      expect(META_FREE_APP_CODES.has(code), code).toBe(true);
    }
    for (const code of [
      "NIGHT_TAKEN",
      "HOLD_DATE_MISMATCHES_EVENT",
      "TERMS_SENT_FOR_ANOTHER_NIGHT",
      "TERMS_AGREED_FOR_ANOTHER_NIGHT",
      "INVALID_STATUS",
      "PLACE_NOT_ACTIVE",
      // P2c, venue side: names the event and both calendars by design.
      "EVENT_ON_ANOTHER_CALENDAR",
    ] as const) {
      expect(META_FREE_APP_CODES.has(code), code).toBe(false);
    }
  });

  it.each([
    "BOOKING_ALREADY_HAS_NIGHT",
    "TERMS_CHANGED_SINCE_VIEWED",
    "EVENT_ON_ANOTHER_NIGHT",
    "EVENT_FIRST_ORIGIN_GONE",
    "LINKED_EVENT_NOT_LIVE",
    "PLACE_NOT_TAKING_BOOKINGS",
    "BOOKING_CANCELLED",
    "BOOKING_NIGHT_BOOKED",
  ] as const)(
    "%s reaches the wire as { appCode } only, whatever the thrower attached",
    (code) => {
      const err = toTrpcError(new AppError(code, { message: `leak ${LEAK.aheadHoldId}`, meta: LEAK }));
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toBe(code);
      expect(metaOf(err)).toEqual({ appCode: code });
    },
  );

  it.each(["TERMS_SENT_FOR_ANOTHER_NIGHT", "TERMS_AGREED_FOR_ANOTHER_NIGHT"] as const)(
    "%s (venue side) keeps its meta",
    (code) => {
      const meta = { agreementId: "a", holdDate: "2026-10-17", termsDate: "2026-10-24" };
      const err = toTrpcError(new AppError(code, { meta }));
      expect(err.code).toBe("CONFLICT");
      expect(metaOf(err)).toEqual({ ...meta, appCode: code });
    },
  );

  it("EVENT_ON_ANOTHER_CALENDAR (venue side, P2c) keeps its meta and is PRECONDITION_FAILED", () => {
    const meta = { agreementId: "a", eventId: "e", eventCalendarId: "x", lineCalendarId: "y", date: "2026-10-17" };
    const err = toTrpcError(new AppError("EVENT_ON_ANOTHER_CALENDAR", { meta }));
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(metaOf(err)).toEqual({ ...meta, appCode: "EVENT_ON_ANOTHER_CALENDAR" });
  });

  it("an AppError that (wrongly) carries meta and a chatty message reaches the wire as the bare code", () => {
    const err = toTrpcError(
      new AppError("NIGHT_NO_LONGER_AVAILABLE", {
        message: `night taken by hold ${LEAK.aheadHoldId}`,
        meta: LEAK,
      }),
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("NIGHT_NO_LONGER_AVAILABLE");
    expect(metaOf(err)).toEqual({ appCode: "NIGHT_NO_LONGER_AVAILABLE" });
    const data = formatWireData(baseShapeData, err);
    expect(data.meta).toEqual({ appCode: "NIGHT_NO_LONGER_AVAILABLE" });
    expect(data.appCode).toBe("NIGHT_NO_LONGER_AVAILABLE");
    // The production-500 scrub path reads the same curated channel.
    expect(readCuratedDomainMeta(err)).toEqual({ appCode: "NIGHT_NO_LONGER_AVAILABLE" });
    expect(JSON.stringify(data)).not.toContain(LEAK.aheadHoldId);
  });

  it("the legacy `{ code, message, meta }` shape is scrubbed the same way", () => {
    const err = toTrpcError({
      code: "conflict",
      message: "night_no_longer_available",
      meta: LEAK,
    });
    expect(err.message).toBe("NIGHT_NO_LONGER_AVAILABLE");
    expect(metaOf(err)).toEqual({ appCode: "NIGHT_NO_LONGER_AVAILABLE" });
  });

  it("leaves NIGHT_TAKEN's venue-side meta intact", () => {
    const err = toTrpcError(new AppError("NIGHT_TAKEN", { meta: LEAK }));
    expect(metaOf(err)).toEqual({ ...LEAK, appCode: "NIGHT_TAKEN" });
  });
});

describe("isInternalAppCode", () => {
  it("returns false for an expected non-500 (precondition) code", () => {
    // PAID_TICKETING_REQUIRES_STRIPE → PRECONDITION_FAILED (412): a normal
    // client-facing precondition, NOT a server fault.
    expect(isInternalAppCode("PAID_TICKETING_REQUIRES_STRIPE")).toBe(false);
  });

  it.each([
    "EVENT_NOT_FOUND", // NOT_FOUND (404)
    "ORDER_NOT_REFUNDABLE", // CONFLICT (409)
    "NON_POSITIVE_AMOUNT", // BAD_REQUEST (400)
    "QUOTA_EXCEEDED", // FORBIDDEN (403)
  ])("returns false for the non-500 code %s", (code) => {
    expect(isInternalAppCode(code)).toBe(false);
  });

  it.each([
    "REFUND_FAILED",
    "REFUND_REJECTED",
    "STORAGE_ERROR",
    "INTERNAL",
  ])("returns true for the INTERNAL_SERVER_ERROR-bucket code %s", (code) => {
    expect(isInternalAppCode(code)).toBe(true);
  });

  it("treats an unrecognized code as internal (keep the Sentry event)", () => {
    expect(isInternalAppCode("TOTALLY_UNKNOWN_CODE")).toBe(true);
    expect(isInternalAppCode("")).toBe(true);
  });

  it("agrees with appCodeToTrpc for every mapped code", () => {
    for (const [code, bucket] of Object.entries(appCodeToTrpc)) {
      expect(isInternalAppCode(code)).toBe(bucket === "INTERNAL_SERVER_ERROR");
    }
  });
});

describe("appCodeToTrpc ⟷ errorCodeMap agreement", () => {
  // The legacy `{ code, message }` path resolves status from `errorCodeMap`
  // (keyed by transport CATEGORY / domain snake codes); a thrown `AppError`
  // resolves from `appCodeToTrpc` (keyed by canonical AppErrorCode). For any
  // logical code present in BOTH, the two MUST return the same HTTP status —
  // otherwise migrating a throw site from the legacy shape to `AppError` (P3)
  // would silently flip the wire status for already-shipped clients.
  it("returns the same tRPC status for every code present in both tables", () => {
    const mismatches: string[] = [];
    for (const [snake, legacyStatus] of Object.entries(errorCodeMap)) {
      const canonical = fromLegacyCode(snake);
      if (!canonical) continue; // category-only key with no canonical form
      const appStatus = appCodeToTrpc[canonical];
      if (appStatus && appStatus !== legacyStatus) {
        mismatches.push(`${snake}→${canonical}: errorCodeMap=${legacyStatus} appCodeToTrpc=${appStatus}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
