import { describe, expect, it } from "vitest";

import { createFakeBookingStandards } from "../booking-standards";

// Pins the fake to the adapter's contract (the adapter's own behaviour is
// pinned against real Postgres in
// packages/adapters/src/db/prisma/__tests__/booking-standards.integration.test.ts).
describe("createFakeBookingStandards", () => {
  const PLACE = { ownerType: "PLACE", ownerId: "place-1" } as const;
  const CAL = { ownerType: "CALENDAR", ownerId: "cal-1" } as const;

  it("stamps sortOrder from array order and returns copies", async () => {
    const fake = createFakeBookingStandards();
    const rows = await fake.replaceItems({
      ...CAL,
      intent: "PERFORM",
      items: [
        { field: "LINK_MUSIC", label: "Music", requirement: "REQUIRED" },
        { field: "GENRE", label: "Genre", hint: "One word", requirement: "SUGGESTED" },
      ],
    });
    expect(rows.map((r) => [r.sortOrder, r.field, r.hint])).toEqual([
      [0, "LINK_MUSIC", null],
      [1, "GENRE", "One word"],
    ]);
    rows[0]!.label = "mutated";
    const read = await fake.listForOwners({ owners: [CAL] });
    expect(read.items[0]!.label).toBe("Music");
  });

  it("replaces ONE (owner, intent) and leaves the rest", async () => {
    const fake = createFakeBookingStandards();
    await fake.replaceItems({
      ...CAL,
      intent: "RENT",
      items: [{ field: "PURPOSE", label: "rent", requirement: "SUGGESTED" }],
    });
    await fake.replaceItems({
      ...PLACE,
      intent: "PERFORM",
      items: [{ field: "FEE", label: "place", requirement: "SUGGESTED" }],
    });
    await fake.replaceItems({
      ...CAL,
      intent: "PERFORM",
      items: [{ field: "GENRE", label: "old", requirement: "SUGGESTED" }],
    });
    await fake.replaceItems({
      ...CAL,
      intent: "PERFORM",
      items: [{ field: "BILL", label: "new", requirement: "SUGGESTED" }],
    });
    const read = await fake.listForOwners({ owners: [CAL, PLACE] });
    // PLACE before CALENDAR, PERFORM before RENT (enum declaration order).
    expect(read.items.map((r) => r.label)).toEqual(["place", "new", "rent"]);
  });

  it("narrows by intent and returns nothing for owners: []", async () => {
    const fake = createFakeBookingStandards();
    await fake.replaceExamples({
      ...CAL,
      intent: "PERFORM",
      examples: [{ title: "p", body: "Body" }],
    });
    await fake.replaceExamples({
      ...CAL,
      intent: "USE",
      examples: [{ title: "u", body: "Body" }],
    });
    const use = await fake.listForOwners({ owners: [CAL], intent: "USE" });
    expect(use.examples.map((r) => r.title)).toEqual(["u"]);
    await expect(fake.listForOwners({ owners: [] })).resolves.toEqual({
      items: [],
      examples: [],
    });
  });

  it("a CUSTOM + REQUIRED item throws the CHECK and leaves the old rows", async () => {
    const fake = createFakeBookingStandards();
    await fake.replaceItems({
      ...CAL,
      intent: "PERFORM",
      items: [{ field: "LINK_MUSIC", label: "Keep", requirement: "REQUIRED" }],
    });
    await expect(
      fake.replaceItems({
        ...CAL,
        intent: "PERFORM",
        items: [
          { field: "GENRE", label: "New", requirement: "SUGGESTED" },
          { field: "CUSTOM", label: "Stage plot", requirement: "REQUIRED" },
        ],
      }),
    ).rejects.toThrow(/BookingStandardItem_custom_is_suggested_check/);
    const read = await fake.listForOwners({ owners: [CAL] });
    expect(read.items.map((r) => r.label)).toEqual(["Keep"]);
  });
});
