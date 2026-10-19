import { describe, expect, it } from "vitest";

import {
  HOLD_LINE_HAS_OPEN_CHALLENGE_CODE,
  isHoldLineOpenChallengeError,
  resolveStoredChargebackTermsOwner,
} from "../publish-gate-helpers";

/**
 * The publish funnel branches on `data.appCode` for the booking-holds rule
 * (spec FR-018) — the code rides the error contract, never the message, so a
 * message that happens to mention the code must NOT match.
 */
describe("isHoldLineOpenChallengeError", () => {
  it("matches the tRPC CONFLICT shape carrying the appCode", () => {
    expect(
      isHoldLineOpenChallengeError({
        message: "HOLD_LINE_HAS_OPEN_CHALLENGE",
        data: {
          code: "CONFLICT",
          appCode: HOLD_LINE_HAS_OPEN_CHALLENGE_CODE,
          meta: { holdId: null, challengedHoldId: "h2", calendarId: "c", date: "2026-12-04" },
        },
      }),
    ).toBe(true);
  });

  it("rejects other codes, message-only mentions, and non-objects", () => {
    expect(isHoldLineOpenChallengeError({ data: { appCode: "HOLD_LINE_CHANGED" } })).toBe(false);
    expect(isHoldLineOpenChallengeError(new Error("HOLD_LINE_HAS_OPEN_CHALLENGE"))).toBe(false);
    expect(isHoldLineOpenChallengeError({ data: null })).toBe(false);
    expect(isHoldLineOpenChallengeError(null)).toBe(false);
    expect(isHoldLineOpenChallengeError("HOLD_LINE_HAS_OPEN_CHALLENGE")).toBe(false);
  });
});

describe("resolveStoredChargebackTermsOwner", () => {
  const orgWorkspace = { ownerType: "org" as const, ownerId: "org-1" };
  const humanWorkspace = { ownerType: "human" as const, ownerId: "h-1" };

  it("reads the org record for an org event in that org's workspace", () => {
    expect(
      resolveStoredChargebackTermsOwner(
        { orgId: "org-1", humanId: null, viewerCanManagePayouts: true },
        orgWorkspace,
      ),
    ).toEqual({ kind: "org", orgId: "org-1" });
  });

  it("guard: reads nothing when the caller's workspace is not the event's org", () => {
    expect(
      resolveStoredChargebackTermsOwner({ orgId: "org-2" }, orgWorkspace),
    ).toBeNull();
    expect(
      resolveStoredChargebackTermsOwner({ orgId: "org-1" }, humanWorkspace),
    ).toBeNull();
  });

  it("reads the signed-in human's profile only when the viewer owns the event", () => {
    expect(
      resolveStoredChargebackTermsOwner(
        { humanId: "h-1", viewerCanManagePayouts: true },
        humanWorkspace,
      ),
    ).toEqual({ kind: "human" });
  });

  it("reads nothing for a delegate on a human-owned event", () => {
    expect(
      resolveStoredChargebackTermsOwner(
        { humanId: "h-1", viewerCanManagePayouts: false },
        humanWorkspace,
      ),
    ).toBeNull();
    expect(
      resolveStoredChargebackTermsOwner({ humanId: "h-1" }, humanWorkspace),
    ).toBeNull();
  });

  it("reads nothing before the event has loaded", () => {
    expect(resolveStoredChargebackTermsOwner(undefined, orgWorkspace)).toBeNull();
  });
});
