import { describe, expect, it } from "vitest";

import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import { buildBillChangedEntry } from "../_shared/bill-changed-entry";
import { BOOKING_SYSTEM_ENTRY_SCHEMAS } from "../messages/_shared/system-entries";
import { REQUEST_ID } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The ONE emitter of `booking_request.bill_changed` (lineup v3, FR-009) —
// pinned against the contract in system-entries.ts and the four consent
// invariants (NFR-002): an invited act never reads as joined, a passed act
// never appears on anything venue-facing, a by-name act is never linked,
// and an edit with nothing venue-visible writes no entry at all.
// ─────────────────────────────────────────────────────────────────────────────

const ID = (n: number) => `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const AT = new Date("2026-06-10T12:00:00.000Z");

function act(
  n: number,
  over: Partial<BookingRequestActRecord> = {},
): BookingRequestActRecord {
  return {
    id: ID(n),
    bookingRequestId: REQUEST_ID,
    source: "TAGGED",
    actOwnerType: "human",
    actOwnerId: ID(n).replace("aaaa-4aaa", "bbbb-4bbb"),
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: n,
    confirmation: "PENDING",
    invitedAt: AT,
    respondedAt: null,
    declineReason: null,
    removedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

const NAMES: Record<string, string> = {
  [ID(0)]: "Hollow Bones",
  [ID(1)]: "Della",
  [ID(2)]: "Junco",
  [ID(3)]: "Paper Moth",
  [ID(4)]: "Maren Sky",
};
const nameOf = (id: string) => NAMES[id] ?? "An artist";
const schema = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.bill_changed"];

const self = (over: Partial<BookingRequestActRecord> = {}) =>
  act(0, { source: "SELF", confirmation: "CONFIRMED", invitedAt: null, ...over });
const invited = (over: Partial<BookingRequestActRecord> = {}) => act(1, over);
const byName = (over: Partial<BookingRequestActRecord> = {}) =>
  act(2, {
    source: "EXTERNAL",
    actOwnerType: null,
    actOwnerId: null,
    externalName: "Junco",
    externalUrl: "https://junco.example",
    confirmation: "CONFIRMED",
    invitedAt: null,
    ...over,
  });
const joined = (over: Partial<BookingRequestActRecord> = {}) =>
  act(3, { confirmation: "CONFIRMED", ...over });
const passed = (over: Partial<BookingRequestActRecord> = {}) =>
  act(4, { confirmation: "DECLINED", ...over });

const removed = { removedAt: AT };

function entry(
  before: BookingRequestActRecord[],
  after: BookingRequestActRecord[],
) {
  const out = buildBillChangedEntry({ before, after, nameOf });
  // Whatever the emitter writes must satisfy the contract, or the ledger
  // append would refuse it.
  if (out) expect(schema.safeParse(out).success).toBe(true);
  return out;
}

describe("buildBillChangedEntry", () => {
  it("records adds with their source-derived state: tagged → invited, by-name → by_name, SELF → joined", () => {
    const before = [joined({ sortOrder: 0 })];
    const after = [
      joined({ sortOrder: 0 }),
      invited({ sortOrder: 1 }),
      byName({ sortOrder: 2 }),
      self({ sortOrder: 3 }),
    ];
    expect(entry(before, after)).toEqual({
      added: [
        { actId: ID(1), name: "Della", source: "TAGGED", state: "invited" },
        { actId: ID(2), name: "Junco", source: "EXTERNAL", state: "by_name" },
        { actId: ID(0), name: "Hollow Bones", source: "SELF", state: "joined" },
      ],
      removed: [],
      otherRemovedCount: 0,
      reordered: false,
      roleChanged: false,
    });
  });

  it("a RESTORED tagged act that had joined is recorded as invited — it is asked again (NFR-002)", () => {
    // The row came back PENDING (restoreAct), so `after` holds it PENDING.
    const before = [joined({ removedAt: AT })];
    const after = [joined({ confirmation: "PENDING" })];
    expect(entry(before, after)?.added).toEqual([
      { actId: ID(3), name: "Paper Moth", source: "TAGGED", state: "invited" },
    ]);
  });

  it("names a removed act only when it had joined or was by name; an invited one is only counted", () => {
    const before = [self(), invited(), byName(), joined()];
    const after = [
      self(),
      invited(removed),
      byName(removed),
      joined(removed),
    ];
    expect(entry(before, after)).toEqual({
      added: [],
      removed: [
        { name: "Junco", wasState: "by_name" },
        { name: "Paper Moth", wasState: "joined" },
      ],
      otherRemovedCount: 1,
      reordered: false,
      roleChanged: false,
    });
    // The invited act's name is nowhere in the entry.
    expect(JSON.stringify(entry(before, after))).not.toContain("Della");
  });

  it("removing ONLY a passed act writes no entry — the venue never saw it", () => {
    expect(entry([self(), passed()], [self(), passed(removed)])).toBeNull();
  });

  it("a passed act's removal leaves no trace beside a visible change", () => {
    const out = entry(
      [self(), passed(), byName()],
      [self(), passed(removed), byName(removed)],
    );
    expect(out).toEqual({
      added: [],
      removed: [{ name: "Junco", wasState: "by_name" }],
      otherRemovedCount: 0,
      reordered: false,
      roleChanged: false,
    });
    expect(JSON.stringify(out)).not.toContain("Maren Sky");
  });

  it("reordered = the relative order of acts visible BOTH before and after changed", () => {
    const before = [self({ sortOrder: 0 }), invited({ sortOrder: 1 }), byName({ sortOrder: 2 })];
    expect(
      entry(before, [self({ sortOrder: 0 }), byName({ sortOrder: 1 }), invited({ sortOrder: 2 })])
        ?.reordered,
    ).toBe(true);
    // An add in front shifts positions but not the relative order: no reorder.
    const withAdd = entry(before, [
      joined({ sortOrder: 0 }),
      self({ sortOrder: 1 }),
      invited({ sortOrder: 2 }),
      byName({ sortOrder: 3 }),
    ]);
    expect(withAdd?.reordered).toBe(false);
    expect(withAdd?.added).toHaveLength(1);
  });

  it("moving a PASSED act around changes nothing the venue sees: no entry", () => {
    const before = [passed({ sortOrder: 0 }), self({ sortOrder: 1 }), invited({ sortOrder: 2 })];
    const after = [self({ sortOrder: 0 }), invited({ sortOrder: 1 }), passed({ sortOrder: 2 })];
    expect(entry(before, after)).toBeNull();
  });

  it("a role-only edit on a visible act (invited included) is recorded as roleChanged", () => {
    expect(
      entry([self(), invited()], [self(), invited({ role: "DJ" })]),
    ).toEqual({
      added: [],
      removed: [],
      otherRemovedCount: 0,
      reordered: false,
      roleChanged: true,
    });
    // A label change beside OTHER is a role change too.
    expect(
      entry(
        [self(), byName({ role: "OTHER", customRoleLabel: "Hype" })],
        [self(), byName({ role: "OTHER", customRoleLabel: "MC" })],
      )?.roleChanged,
    ).toBe(true);
  });

  it("a passed act's role change is never recorded: no entry", () => {
    expect(entry([self(), passed()], [self(), passed({ role: "HOST" })])).toBeNull();
  });

  it("an unchanged bill writes no entry", () => {
    const bill = [self(), invited(), byName()];
    expect(entry(bill, bill)).toBeNull();
  });

  it("never carries a link, an owner id, or a passed / invited marker in removed[]", () => {
    const out = entry(
      [self(), invited(), byName(), joined(), passed()],
      [self(removed), invited(removed), byName(removed), joined(removed), passed(removed)],
    );
    const json = JSON.stringify(out);
    expect(json).not.toContain("https://");
    expect(json).not.toContain("bbbb-4bbb");
    expect(out?.removed.map((row) => row.wasState)).toEqual(["joined", "by_name", "joined"]);
    expect(out?.otherRemovedCount).toBe(1);
  });
});
