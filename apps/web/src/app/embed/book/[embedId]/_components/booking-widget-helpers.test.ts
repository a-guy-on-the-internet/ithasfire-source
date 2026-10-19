import { describe, expect, it } from "vitest";

import { EMBED_ORIGIN_BLOCKED_MESSAGE } from "@/lib/embed-host-origin";

import {
  EMPTY_PITCH_VALUES,
  buildEmbedPitchPayload,
  mapEmbedBookingSubmitError,
  validateContactEmail,
  validateContactName,
  type EmbedPitchValues,
} from "./booking-widget-helpers";

const validValues: EmbedPitchValues = {
  ...EMPTY_PITCH_VALUES,
  actName: "The Ember Set",
  message: "We're a four-piece indie band looking for a Friday slot.",
  preferredDates: ["2026-08-14"],
};

describe("buildEmbedPitchPayload", () => {
  it("requires an act name on the anonymous path", () => {
    const result = buildEmbedPitchPayload(
      { ...validValues, actName: "   " },
      { requireActName: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("actName");
      expect(result.error.message).toMatch(/act or band name/i);
    }
  });

  it("allows a missing act name on the signed-in path", () => {
    const result = buildEmbedPitchPayload(
      { ...validValues, actName: "" },
      { requireActName: false, senderOwnerType: "human" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.actName).toBeUndefined();
    }
  });

  it("builds the wire payload with converted numeric fields", () => {
    const result = buildEmbedPitchPayload(
      {
        ...validValues,
        lineupSize: "4",
        setLengthMinutes: "45",
        expectedDraw: "80",
        feeType: "GUARANTEE",
        feeAmountDollars: "250",
        linkMusic: "https://example.com/music",
      },
      { requireActName: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toMatchObject({
        actName: "The Ember Set",
        preferredDates: ["2026-08-14"],
        lineupSize: 4,
        setLengthMinutes: 45,
        expectedDraw: 80,
        feeType: "GUARANTEE",
        feeAmountCents: 25_000,
        linkMusic: "https://example.com/music",
      });
      // The embed form never emits the platform-only extras.
      expect(result.payload.includeVerifiedStats).toBeUndefined();
      expect(result.payload.contactPhone).toBeUndefined();
    }
  });

  it("maps a too-short message to the message field with English copy", () => {
    const result = buildEmbedPitchPayload(
      { ...validValues, message: "hi" },
      { requireActName: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("message");
      expect(result.error.message).toMatch(/at least 10 characters/i);
    }
  });

  it("maps missing dates to the dates field", () => {
    const result = buildEmbedPitchPayload(
      { ...validValues, preferredDates: ["", ""] },
      { requireActName: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("dates");
    }
  });

  it("maps an invalid link to the links field", () => {
    const result = buildEmbedPitchPayload(
      { ...validValues, linkEpk: "not-a-url" },
      { requireActName: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("links");
      expect(result.error.message).toMatch(/web addresses/i);
    }
  });
});

describe("contact validators", () => {
  it("requires a name and bounds its length", () => {
    expect(validateContactName("")).toMatch(/enter your name/i);
    expect(validateContactName("a".repeat(121))).toMatch(/120 characters/);
    expect(validateContactName("Sam Rivers")).toBeNull();
  });

  it("requires a plausible email", () => {
    expect(validateContactEmail("")).toMatch(/enter your email/i);
    expect(validateContactEmail("not-an-email")).toMatch(/valid email/i);
    expect(validateContactEmail("with spaces@example.com")).toMatch(
      /valid email/i,
    );
    expect(validateContactEmail("band@example.com")).toBeNull();
  });
});

describe("mapEmbedBookingSubmitError", () => {
  const trpcError = (appCode: string | null, code: string) => ({
    data: { ...(appCode ? { appCode } : {}), code },
    message: "boom",
  });

  it("maps DUPLICATE_OPEN_REQUEST", () => {
    const mapped = mapEmbedBookingSubmitError(
      trpcError("DUPLICATE_OPEN_REQUEST", "CONFLICT"),
    );
    expect(mapped.kind).toBe("duplicate");
    expect(mapped.message).toMatch(/already have an open request/i);
  });

  it("maps both Turnstile codes", () => {
    for (const code of [
      "TURNSTILE_TOKEN_REQUIRED",
      "TURNSTILE_VERIFICATION_FAILED",
    ]) {
      expect(
        mapEmbedBookingSubmitError(trpcError(code, "BAD_REQUEST")).kind,
      ).toBe("turnstile");
    }
  });

  it("maps the not-accepting gates", () => {
    for (const code of [
      "PLACE_NOT_ACCEPTING_REQUESTS",
      "PLACE_NOT_VERIFIED",
      // P3a (amendment 2026-09-25): an unclaimed place.
      "PLACE_NOT_TAKING_REQUESTS",
    ]) {
      expect(
        mapEmbedBookingSubmitError(trpcError(code, "FORBIDDEN")).kind,
      ).toBe("notAccepting");
    }
  });

  // ── P3a (unclaimed venues) ──
  it("maps PLACE_NOT_TAKING_REQUESTS as the server sends it (PRECONDITION_FAILED) to not-accepting", () => {
    expect(
      mapEmbedBookingSubmitError(
        trpcError("PLACE_NOT_TAKING_REQUESTS", "PRECONDITION_FAILED"),
      ).kind,
    ).toBe("notAccepting");
  });

  it("maps EMBED_ORIGIN_NOT_ALLOWED before the FORBIDDEN bucket", () => {
    const mapped = mapEmbedBookingSubmitError(
      trpcError("EMBED_ORIGIN_NOT_ALLOWED", "FORBIDDEN"),
    );
    expect(mapped.kind).toBe("origin");
    expect(mapped.message).toBe(EMBED_ORIGIN_BLOCKED_MESSAGE);
  });

  it("maps the per-IP rate limit (no appCode / no meta) to the connection copy", () => {
    const mapped = mapEmbedBookingSubmitError(
      trpcError(null, "TOO_MANY_REQUESTS"),
    );
    expect(mapped.kind).toBe("rateLimited");
    expect(mapped.message).toMatch(/from this connection/i);
    expect(mapped.message).toMatch(/wait a minute/i);
  });

  it("maps the per-place daily cap to the try-again-tomorrow copy", () => {
    const mapped = mapEmbedBookingSubmitError({
      data: {
        code: "TOO_MANY_REQUESTS",
        appCode: "RATE_LIMITED",
        meta: {
          scope: "booking_inquiry_place_daily",
          retryAfterSeconds: 43_200,
        },
      },
      message: "boom",
    });
    expect(mapped.kind).toBe("rateLimited");
    expect(mapped.message).toMatch(/today's booking request limit/i);
    expect(mapped.message).toMatch(/try again tomorrow/i);
    expect(mapped.message).not.toMatch(/connection/i);
  });

  it("maps UNAUTHORIZED to the session-expired kind", () => {
    expect(
      mapEmbedBookingSubmitError(trpcError(null, "UNAUTHORIZED")).kind,
    ).toBe("unauthorized");
  });

  it("maps PERFORMER_MODE_REQUIRED and NOT_RESOURCE_OWNER", () => {
    expect(
      mapEmbedBookingSubmitError(trpcError("PERFORMER_MODE_REQUIRED", "FORBIDDEN"))
        .kind,
    ).toBe("performerMode");
    expect(
      mapEmbedBookingSubmitError(trpcError("NOT_RESOURCE_OWNER", "FORBIDDEN"))
        .kind,
    ).toBe("notOwner");
  });

  it("falls back to a generic message", () => {
    const mapped = mapEmbedBookingSubmitError(new Error("network down"));
    expect(mapped.kind).toBe("generic");
    expect(mapped.message).toMatch(/something went wrong/i);
  });
});
