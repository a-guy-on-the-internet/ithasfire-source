import { describe, expect, it } from "vitest";

import {
  asOrgIdFor,
  billIndex,
  deriveInviteState,
  formatPreferredDate,
  isNotFoundLike,
  mergeBill,
  passReasonInput,
  positionLabel,
  refusalReasonOf,
  waitingNoteKey,
  type ActInvite,
  type InviteIdentity,
} from "../invite-view";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

function identity(
  overrides: Partial<InviteIdentity["myAct"]> = {},
  answeringAs: Partial<InviteIdentity["answeringAs"]> = {},
  extra: Partial<InviteIdentity> = {},
): InviteIdentity {
  return {
    answeringAs: {
      ownerType: "human",
      ownerId: HUMAN,
      displayName: "The Sallows",
      href: "/humans/the-sallows",
      ...answeringAs,
    },
    myAct: {
      id: "33333333-3333-4333-8333-333333333333",
      confirmation: "PENDING",
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 1,
      respondedAt: null,
      ...overrides,
    },
    canConfirm: true,
    canDecline: true,
    confirmBlockedReason: null,
    declineBlockedReason: null,
    ...extra,
  };
}

describe("deriveInviteState", () => {
  const open = { status: "PENDING" as const, eventMinted: false };

  it("is waiting for a pending spot on an open request", () => {
    expect(deriveInviteState(open, identity())).toBe("waiting");
  });

  it("is joined for a confirmed spot before any event exists", () => {
    expect(
      deriveInviteState(open, identity({ confirmation: "CONFIRMED" })),
    ).toBe("joined");
  });

  it("is passed for a declined spot, even once the request closed", () => {
    expect(
      deriveInviteState(
        { status: "WITHDRAWN", eventMinted: false },
        identity({ confirmation: "DECLINED" }),
      ),
    ).toBe("passed");
  });

  it.each(["DECLINED", "WITHDRAWN", "EXPIRED"] as const)(
    "is closed when the request is %s",
    (status) => {
      expect(
        deriveInviteState({ status, eventMinted: false }, identity()),
      ).toBe("closed");
      expect(
        deriveInviteState(
          { status, eventMinted: false },
          identity({ confirmation: "CONFIRMED" }),
        ),
      ).toBe("closed");
    },
  );

  it("is closed when confirm is refused as request_closed", () => {
    expect(
      deriveInviteState(
        open,
        identity({}, {}, { confirmBlockedReason: "request_closed" }),
      ),
    ).toBe("closed");
  });

  it("is booked when the joined spot is on the minted event's lineup", () => {
    expect(
      deriveInviteState(
        { status: "ACCEPTED", eventMinted: true },
        identity(
          { confirmation: "CONFIRMED" },
          {},
          { canDecline: false, declineBlockedReason: "on_lineup" },
        ),
      ),
    ).toBe("booked");
  });

  it("is joined when an event exists but the spot is not on its lineup", () => {
    // Removed by the editor, or joined after the mint: leaving stays open.
    expect(
      deriveInviteState(
        { status: "ACCEPTED", eventMinted: true },
        identity({ confirmation: "CONFIRMED" }),
      ),
    ).toBe("joined");
  });

  it("still waits for a pending spot on an accepted request with an event", () => {
    expect(
      deriveInviteState({ status: "ACCEPTED", eventMinted: true }, identity()),
    ).toBe("waiting");
  });
});

describe("positionLabel", () => {
  it("headlines at position 0", () => {
    expect(positionLabel(0, "en")).toEqual({ kind: "headline" });
  });

  it("uses English ordinal categories from 1-based positions", () => {
    expect(positionLabel(1, "en")).toEqual({
      kind: "ordinal",
      n: 2,
      category: "two",
    });
    expect(positionLabel(2, "en")).toMatchObject({ n: 3, category: "few" });
    expect(positionLabel(3, "en")).toMatchObject({ n: 4, category: "other" });
    expect(positionLabel(20, "en")).toMatchObject({ n: 21, category: "one" });
  });

  it("falls back to other for Spanish", () => {
    expect(positionLabel(1, "es")).toMatchObject({ n: 2, category: "other" });
  });
});

describe("billIndex", () => {
  it("is 1-based and two digits", () => {
    expect(billIndex(0)).toBe("01");
    expect(billIndex(9)).toBe("10");
  });
});

describe("mergeBill", () => {
  const invite: Pick<ActInvite, "otherActs" | "identities"> = {
    otherActs: [
      {
        source: "EXTERNAL",
        displayName: "Junebug Radio",
        // Defensive: even if a link ever arrived, a by-name act never links.
        href: "/should-not-link",
        role: "DJ",
        customRoleLabel: null,
        sortOrder: 2,
      },
      {
        source: "TAGGED",
        displayName: "Paper Moth",
        href: "/humans/paper-moth",
        role: "PERFORMER",
        customRoleLabel: null,
        sortOrder: 0,
      },
    ],
    identities: [identity()],
  };

  it("merges the viewer's spot with the others in position order", () => {
    const rows = mergeBill(invite);
    expect(rows.map((row) => row.displayName)).toEqual([
      "Paper Moth",
      "The Sallows",
      "Junebug Radio",
    ]);
    expect(rows.map((row) => row.mine)).toEqual([false, true, false]);
  });

  it("marks by-name acts and never links them", () => {
    const external = mergeBill(invite).find((row) => row.byName);
    expect(external?.href).toBeNull();
    expect(external?.displayName).toBe("Junebug Radio");
  });

  it("marks a passed own spot", () => {
    const rows = mergeBill({
      ...invite,
      identities: [identity({ confirmation: "DECLINED" })],
    });
    expect(rows.find((row) => row.mine)?.passed).toBe(true);
  });
});

describe("asOrgIdFor", () => {
  it("is absent for yourself and the org id for a group", () => {
    expect(asOrgIdFor(identity())).toBeUndefined();
    expect(asOrgIdFor(identity({}, { ownerType: "organization", ownerId: ORG }))).toBe(ORG);
  });
});

describe("formatPreferredDate", () => {
  it("prints a timed wall clock exactly as picked", () => {
    expect(formatPreferredDate("2026-10-17T20:00", "en-US")).toBe(
      "Sat, Oct 17 · 8:00 PM",
    );
  });

  it("prints a date-only entry without shifting the day", () => {
    expect(formatPreferredDate("2026-10-17", "en-US")).toBe("Sat, Oct 17");
  });

  it("shows anything unparseable as stored", () => {
    expect(formatPreferredDate("someday", "en-US")).toBe("someday");
  });
});

describe("passReasonInput", () => {
  it("trims and drops an empty reason", () => {
    expect(passReasonInput("   ")).toBeUndefined();
    expect(passReasonInput("  Touring that week.  ")).toBe(
      "Touring that week.",
    );
  });
});

describe("refusalReasonOf", () => {
  it("reads ACT_ALREADY_DECLINED as act_declined", () => {
    expect(
      refusalReasonOf({ message: "x", data: { appCode: "ACT_ALREADY_DECLINED" } }),
    ).toBe("act_declined");
  });

  it("reads the INVALID_STATUS meta reason", () => {
    expect(
      refusalReasonOf({
        message: "booking_request_act_on_lineup",
        data: { appCode: "INVALID_STATUS", meta: { reason: "on_lineup" } },
      }),
    ).toBe("on_lineup");
  });

  it("falls back to the message when meta is missing", () => {
    expect(
      refusalReasonOf({ message: "booking_request_act_request_closed" }),
    ).toBe("request_closed");
  });

  it("is null for anything else", () => {
    expect(refusalReasonOf(new Error("network down"))).toBeNull();
    expect(
      refusalReasonOf({ message: "x", data: { meta: { reason: "nope" } } }),
    ).toBeNull();
    expect(refusalReasonOf(null)).toBeNull();
  });
});

describe("isNotFoundLike", () => {
  it("treats not-found, NOT_FOUND and BAD_REQUEST the same", () => {
    expect(
      isNotFoundLike({ data: { appCode: "BOOKING_REQUEST_NOT_FOUND" } }),
    ).toBe(true);
    expect(isNotFoundLike({ data: { code: "NOT_FOUND" } })).toBe(true);
    expect(isNotFoundLike({ data: { code: "BAD_REQUEST" } })).toBe(true);
    expect(isNotFoundLike({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(
      false,
    );
  });
});

describe("waitingNoteKey", () => {
  it("warns that a join after the mint goes straight onto the lineup", () => {
    expect(waitingNoteKey({ eventMinted: true })).toBe(
      "bookingActInvite.noteJoinAfterMint",
    );
  });

  it("says you can leave until the night is booked before any event", () => {
    expect(waitingNoteKey({ eventMinted: false })).toBe(
      "bookingActInvite.noteLeaveAndPass",
    );
  });
});
