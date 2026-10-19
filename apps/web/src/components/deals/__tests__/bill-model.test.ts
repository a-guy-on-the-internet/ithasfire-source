import { describe, expect, it } from "vitest";

import {
  billInOrder,
  billIndexLabel,
  billSuggestionsOf,
  billTagOf,
  type BillItem,
} from "../bill-model";
import type { DealPerson } from "../deal-model";

const ACT_ORG = "22222222-2222-4222-8222-222222222222";
const SUPPORT_HUMAN = "33333333-3333-4333-8333-333333333333";
const PLACE_ORG = "11111111-1111-4111-8111-111111111111";

function item(overrides: Partial<BillItem>): BillItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    source: "TAGGED",
    displayName: "Paper Moth",
    href: null,
    confirmation: "CONFIRMED",
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    isSender: false,
    joinedAs: null,
    ...overrides,
  } as BillItem;
}

describe("billTagOf", () => {
  it("never calls a by-name act invited, and never an open invite joined", () => {
    expect(billTagOf({ source: "EXTERNAL", confirmation: "PENDING" })).toBe(
      "byName",
    );
    expect(billTagOf({ source: "TAGGED", confirmation: "PENDING" })).toBe(
      "invited",
    );
    expect(billTagOf({ source: "TAGGED", confirmation: "CONFIRMED" })).toBe(
      "joined",
    );
    expect(billTagOf({ source: "SELF", confirmation: "CONFIRMED" })).toBe(
      "joined",
    );
    expect(billTagOf({ source: "TAGGED", confirmation: "DECLINED" })).toBe(
      "passed",
    );
  });
});

describe("the bill's running order", () => {
  it("sorts by position and numbers from 01", () => {
    const ordered = billInOrder([
      item({ id: "b", sortOrder: 1, displayName: "The Sallows" }),
      item({ id: "a", sortOrder: 0, displayName: "Paper Moth" }),
    ]);
    expect(ordered.map((i) => i.displayName)).toEqual([
      "Paper Moth",
      "The Sallows",
    ]);
    expect(billIndexLabel(0)).toBe("01");
    expect(billIndexLabel(11)).toBe("12");
  });
});

describe("billSuggestionsOf", () => {
  const parties: DealPerson[] = [
    { ref: { kind: "org", id: PLACE_ORG }, name: "Marrow Hall" },
    { ref: { kind: "org", id: ACT_ORG }, name: "Lowlight Collective" },
  ];

  it("offers only acts that joined, by their platform identity", () => {
    const out = billSuggestionsOf(
      [
        item({
          id: "a",
          sortOrder: 0,
          displayName: "Paper Moth",
          joinedAs: { ownerType: "human", ownerId: SUPPORT_HUMAN },
        }),
        item({
          id: "b",
          sortOrder: 1,
          displayName: "The Sallows",
          confirmation: "PENDING",
          joinedAs: null,
        }),
        item({
          id: "c",
          sortOrder: 2,
          source: "EXTERNAL",
          displayName: "Junebug Radio",
          joinedAs: null,
        }),
      ],
      parties,
      "Unnamed",
    );
    expect(out).toEqual([
      {
        ref: { kind: "human", id: SUPPORT_HUMAN },
        name: "Paper Moth",
        source: "bill",
      },
    ]);
  });

  it("leaves out a party (the sender's own act) and names a nameless act", () => {
    const out = billSuggestionsOf(
      [
        item({
          id: "self",
          source: "SELF",
          isSender: true,
          joinedAs: { ownerType: "organization", ownerId: ACT_ORG },
        }),
        item({
          id: "x",
          sortOrder: 1,
          displayName: null,
          joinedAs: { ownerType: "human", ownerId: SUPPORT_HUMAN },
        }),
      ],
      parties,
      "Unnamed act",
    );
    expect(out).toEqual([
      {
        ref: { kind: "human", id: SUPPORT_HUMAN },
        name: "Unnamed act",
        source: "bill",
      },
    ]);
  });
});
