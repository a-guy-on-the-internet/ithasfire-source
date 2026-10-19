import { describe, it, expect } from "vitest";

import {
  type AppErrorCode,
  APP_ERROR_CODES,
  fromLegacyCode,
  INTERNAL_CODES,
  isInternalCode,
  toKey,
  USER_FACING_CODES,
} from "../index";

describe("toKey", () => {
  it("maps SCREAMING_SNAKE to camelCase", () => {
    expect(toKey("EVENT_NOT_FOUND")).toBe("eventNotFound");
  });

  it("handles single-word codes", () => {
    expect(toKey("FORBIDDEN")).toBe("forbidden");
  });

  it("handles long codes", () => {
    expect(toKey("STRIPE_NOT_CONNECTED_OWNER")).toBe("stripeNotConnectedOwner");
  });

  it("round-trips with fromLegacyCode via the snake form", () => {
    for (const code of APP_ERROR_CODES) {
      // camelCase key → snake_case via reverse → back to the same code.
      const snake = toKey(code).replace(
        /[A-Z0-9]/g,
        (c) => `_${c.toLowerCase()}`,
      );
      expect(fromLegacyCode(snake)).toBe(code);
    }
  });
});

describe("APP_ERROR_CODES", () => {
  it("has no duplicate entries", () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
  });

  it("contains only digit-free codes (toKey round-trip precondition)", () => {
    // The toKey/reverse transforms are only proven inverses for digit-free
    // codes. Guard the invariant the comment on toKey relies on.
    for (const code of APP_ERROR_CODES) {
      expect(code).not.toMatch(/[0-9]/);
    }
  });

  it("does not include pure-UI validation copy keys", () => {
    // The union is throwable backend codes only — not form-validation copy.
    const removed = [
      "GENERIC",
      "FIELD_REQUIRED",
      "TITLE_REQUIRED",
      "START_DATE_REQUIRED",
      "END_DATE_REQUIRED",
    ];
    for (const code of removed) {
      expect(APP_ERROR_CODES as readonly string[]).not.toContain(code);
    }
  });
});

describe("tier partition", () => {
  it("USER_FACING_CODES ∪ INTERNAL_CODES === APP_ERROR_CODES", () => {
    const tiered = new Set<string>([...USER_FACING_CODES, ...INTERNAL_CODES]);
    expect(tiered.size).toBe(APP_ERROR_CODES.length);
    for (const code of APP_ERROR_CODES) expect(tiered.has(code)).toBe(true);
  });

  it("the two tiers are disjoint (no code in both)", () => {
    const internal = new Set<string>(INTERNAL_CODES);
    const overlap = USER_FACING_CODES.filter((c) => internal.has(c));
    expect(overlap).toEqual([]);
  });

  it("isInternalCode agrees with INTERNAL_CODES", () => {
    for (const code of INTERNAL_CODES) expect(isInternalCode(code)).toBe(true);
    for (const code of USER_FACING_CODES) expect(isInternalCode(code)).toBe(false);
  });
});

describe("fromLegacyCode", () => {
  it("upcases a known snake_case domain code", () => {
    expect(fromLegacyCode("event_not_found")).toBe("EVENT_NOT_FOUND");
  });

  it("returns null for a retired collapse alias (now migrated at the source)", () => {
    // not_event_owner / agreement_percent_total_exceeds_100 were COLLAPSED/renamed
    // and every throw site now emits the canonical directly, so the boundary no
    // longer needs to resolve the old snake form.
    expect(fromLegacyCode("not_event_owner")).toBeNull();
  });

  it("passes through an already-SCREAMING code", () => {
    expect(fromLegacyCode("EVENT_NOT_FOUND")).toBe("EVENT_NOT_FOUND");
  });

  it("returns null for an unknown code", () => {
    expect(fromLegacyCode("made_up_code")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(fromLegacyCode("")).toBeNull();
  });

  it("normalizes a transport category", () => {
    const code: AppErrorCode | null = fromLegacyCode("forbidden");
    expect(code).toBe("FORBIDDEN");
  });
});
