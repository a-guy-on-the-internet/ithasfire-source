import { describe, expect, it } from "vitest";

import { AppError, fail, isAppError } from "@th/errors";

import {
  committedHoldIntentsOf,
  withCommittedHoldIntents,
  type CommittedHoldIntents,
} from "../_shared/booking-hold-intents";

// ─────────────────────────────────────────────────────────────────────────────
// The committed-intents carrier (booking-the-night review W6 / round-2 nit 2):
// always a FRESH object carrying the notices, never the thrown one mutated —
// so attaching can never fail (no swallow) — and keeping what the transport
// reads (code / message / meta / cause).
// ─────────────────────────────────────────────────────────────────────────────

const committed: CommittedHoldIntents = {
  notificationIntents: [
    {
      kind: "hold.lost_date",
      bookingRequestId: "45454545-4545-4545-8545-454545454545",
      holdId: "00000000-0000-4000-8000-000000000001",
      audience: "act",
      date: "2026-10-17",
      reason: "CONFIRMED_OTHER",
    },
  ],
  staffRecipientHint: {
    assigneeHumanId: null,
    placedByHumanId: "11111111-1111-4111-8111-111111111111",
    orgId: null,
    placeId: "33333333-3333-4333-8333-333333333333",
  },
  bookingRequestId: "44444444-4444-4444-8444-444444444444",
};

function caught(fn: () => never): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("withCommittedHoldIntents", () => {
  it("an AppError → a fresh AppError: same code, message, meta; the original as cause; notices attached", () => {
    const original = caught(() => fail("NOT_RESOURCE_OWNER", { meta: { entity: "place" } }));
    const carrier = withCommittedHoldIntents(original, committed);

    expect(carrier).not.toBe(original);
    expect(isAppError(carrier)).toBe(true);
    expect(carrier).toMatchObject({ code: "NOT_RESOURCE_OWNER", meta: { entity: "place" } });
    expect((carrier as AppError).cause).toBe(original);
    expect(committedHoldIntentsOf(carrier)).toBe(committed);
    expect(committedHoldIntentsOf(original)).toBeNull();
  });

  it("a FROZEN error still carries them (nothing is defined on the thrown object)", () => {
    const original = Object.freeze(Object.assign(new Error("quota"), { code: "forbidden", meta: { x: 1 } }));
    const carrier = withCommittedHoldIntents(original, committed);

    expect(carrier).toMatchObject({ message: "quota", code: "forbidden", meta: { x: 1 } });
    expect((carrier as Error).cause).toBe(original);
    expect(committedHoldIntentsOf(carrier)).toBe(committed);
  });

  it("a legacy { code, message } object → a shallow copy carrying them", () => {
    const original = Object.freeze({ code: "conflict", message: "agreement_status_changed" });
    const carrier = withCommittedHoldIntents(original, committed);

    expect(carrier).toEqual({ code: "conflict", message: "agreement_status_changed" });
    expect(committedHoldIntentsOf(carrier)).toBe(committed);
  });

  it("the notices never become an enumerable field (no log line, no wire)", () => {
    const carrier = withCommittedHoldIntents(new Error("x"), committed);
    expect(Object.keys(carrier as object)).not.toContain("notificationIntents");
    expect(JSON.stringify(carrier)).not.toContain("lost_date");
  });

  it("nothing owed → the error unchanged", () => {
    const original = new Error("x");
    expect(withCommittedHoldIntents(original, { ...committed, notificationIntents: [] })).toBe(original);
  });
});
