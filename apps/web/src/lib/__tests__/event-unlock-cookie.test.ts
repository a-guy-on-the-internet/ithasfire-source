// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  secret: "event-unlock-secret-with-at-least-32-chars" as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/config/env.server", () => ({
  webEnv: {
    get betterAuth() {
      return { secret: env.secret };
    },
  },
}));

import {
  EVENT_UNLOCK_TTL_MS,
  buildEventApplicationGrantSetCookie,
  buildEventInviteGrantSetCookie,
  eventApplicationGrantCookieName,
  eventInviteGrantCookieName,
  verifyEventUnlockCookie,
} from "../event-unlock-cookie";

const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
/** The submission's `reviewedAt` for the redeemed approval (2025-12-05T12:00:00.123Z). */
const APPROVED_AT_MS = 1764936000123;

/**
 * Golden vector shared with
 * `packages/transport/trpc/src/routers/__tests__/application-grant.test.ts`:
 * the web SIGNS the grant and the API VERIFIES it with a separate
 * implementation, so both sides pin the same bytes. v2 format:
 * `<submissionId>.<approvedAtMs>.<expMs>.<sig>`, HMAC over
 * `th_ea|v2|<eventId>|<submissionId>|<approvedAtMs>|<expMs>`.
 */
const GOLDEN_VALUE = `${SUBMISSION_ID}.${APPROVED_AT_MS}.4102444800000.ofUph3shHCaisM2M2ZnLmfdpWzXlv93iXBvdly5VV5U`;

describe("buildEventApplicationGrantSetCookie", () => {
  beforeEach(() => {
    env.secret = "event-unlock-secret-with-at-least-32-chars";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs the grant in the format the API verifies (golden vector)", () => {
    vi.spyOn(Date, "now").mockReturnValue(4102444800000 - EVENT_UNLOCK_TTL_MS);

    const cookie = buildEventApplicationGrantSetCookie(
      EVENT_ID,
      SUBMISSION_ID,
      APPROVED_AT_MS,
    );

    expect(cookie).toMatch(
      new RegExp(`^th_ea_${EVENT_ID}=${GOLDEN_VALUE.replace(/\./g, "\\.")};`),
    );
  });

  it("uses the password cookie's flags and a TTL no longer than it", () => {
    const cookie = buildEventApplicationGrantSetCookie(
      EVENT_ID,
      SUBMISSION_ID,
      APPROVED_AT_MS,
    )!;

    expect(cookie).toContain("; Path=/;");
    expect(cookie).toContain(`; Max-Age=${EVENT_UNLOCK_TTL_MS / 1000};`);
    expect(cookie).toContain("; HttpOnly;");
    expect(cookie).toContain("SameSite=Lax");
    expect(eventApplicationGrantCookieName(EVENT_ID)).toBe(`th_ea_${EVENT_ID}`);
  });

  it("returns null without a usable signing secret", () => {
    env.secret = "short";
    expect(
      buildEventApplicationGrantSetCookie(EVENT_ID, SUBMISSION_ID, APPROVED_AT_MS),
    ).toBeNull();
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses to sign an unusable approval stamp (%s)",
    (approvedAtMs) => {
      expect(
        buildEventApplicationGrantSetCookie(EVENT_ID, SUBMISSION_ID, approvedAtMs),
      ).toBeNull();
    },
  );

  it("a grant's value never verifies as a password unlock", () => {
    const cookie = buildEventApplicationGrantSetCookie(
      EVENT_ID,
      SUBMISSION_ID,
      APPROVED_AT_MS,
    )!;
    const value = cookie.split(";")[0]!.split("=")[1]!;
    expect(verifyEventUnlockCookie(EVENT_ID, value)).toBe(false);
  });
});

describe("buildEventInviteGrantSetCookie", () => {
  const INVITE_ID = "90000000-0000-4000-8000-000000000009";
  const EXP_MS = 4102444800000;
  /**
   * Golden vector shared with the API's reader
   * (`packages/transport/trpc/src/event-unlock-cookie.ts`,
   * `readEventInviteGrantCookie`): `<inviteId>.<expMs>.<sig>`, HMAC over
   * `th_ei|v1|<eventId>|<inviteId>|<expMs>`.
   */
  const GOLDEN_PAIR = `th_ei_${EVENT_ID}=${INVITE_ID}.${EXP_MS}.FL9PARNJlJu5VNuT_uWWCpqC8LwbgTWT93wlcxovhd0`;

  beforeEach(() => {
    env.secret = "event-unlock-secret-with-at-least-32-chars";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs the grant in the format the API verifies (golden vector)", () => {
    const cookie = buildEventInviteGrantSetCookie(EVENT_ID, INVITE_ID, EXP_MS)!;
    expect(cookie.split(";")[0]).toBe(GOLDEN_PAIR);
    expect(eventInviteGrantCookieName(EVENT_ID)).toBe(`th_ei_${EVENT_ID}`);
  });

  it("uses the other gate cookies' flags and a Max-Age that ends at expMs", () => {
    const now = EXP_MS - 3 * 60 * 60 * 1000 - 500;
    vi.spyOn(Date, "now").mockReturnValue(now);

    const cookie = buildEventInviteGrantSetCookie(EVENT_ID, INVITE_ID, EXP_MS)!;

    expect(cookie).toContain("; Path=/;");
    // 3h + 0.5s left → floor, so the browser drops it no later than expMs.
    expect(cookie).toContain(`; Max-Age=${3 * 60 * 60};`);
    expect(cookie).toContain("; HttpOnly;");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("sets nothing once the event has ended", () => {
    vi.spyOn(Date, "now").mockReturnValue(EXP_MS - 999);
    expect(buildEventInviteGrantSetCookie(EVENT_ID, INVITE_ID, EXP_MS)).toBeNull();
  });

  it("returns null without a usable signing secret", () => {
    env.secret = "short";
    expect(buildEventInviteGrantSetCookie(EVENT_ID, INVITE_ID, EXP_MS)).toBeNull();
  });

  it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an unusable expiry (%s)",
    (expMs) => {
      expect(buildEventInviteGrantSetCookie(EVENT_ID, INVITE_ID, expMs)).toBeNull();
    },
  );

  it("an invite grant never verifies as a password unlock", () => {
    const value = GOLDEN_PAIR.split("=")[1]!;
    expect(verifyEventUnlockCookie(EVENT_ID, value)).toBe(false);
  });
});
