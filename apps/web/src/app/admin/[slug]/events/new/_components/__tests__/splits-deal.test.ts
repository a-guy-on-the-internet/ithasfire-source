import { describe, expect, it } from "vitest";

import { eventDealParty, lineupSuggestionsOf } from "../splits-deal";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER_HUMAN = "22222222-2222-4222-8222-222222222222";
const ACT_HUMAN = "33333333-3333-4333-8333-333333333333";

describe("eventDealParty", () => {
  it("names an org-owned event's party from the viewer's own groups", () => {
    expect(
      eventDealParty(
        { orgId: ORG, humanId: null },
        [{ kind: "org", orgId: ORG, orgName: "Marrow Hall" }],
        "Marrow Hall (payee)",
        "Unnamed",
      ),
    ).toEqual({
      ref: { kind: "org", id: ORG },
      name: "Marrow Hall",
      source: "party",
    });
  });

  it("falls back to the owner's payout line, then to the fallback name", () => {
    expect(
      eventDealParty(
        { orgId: ORG, humanId: null },
        [],
        "Marrow Hall",
        "Unnamed",
      )?.name,
    ).toBe("Marrow Hall");
    expect(
      eventDealParty({ orgId: ORG, humanId: null }, undefined, null, "Unnamed")
        ?.name,
    ).toBe("Unnamed");
  });

  it("makes a human-owned event's party the person", () => {
    expect(
      eventDealParty(
        { orgId: null, humanId: OWNER_HUMAN },
        [{ kind: "human", humanId: OWNER_HUMAN, humanName: "Sam Okonkwo" }],
        null,
        "Unnamed",
      ),
    ).toEqual({
      ref: { kind: "human", id: OWNER_HUMAN },
      name: "Sam Okonkwo",
      source: "party",
    });
  });

  it("is null until the owner is known, and for an ownerless row", () => {
    expect(eventDealParty(undefined, [], null, "Unnamed")).toBeNull();
    expect(
      eventDealParty({ orgId: null, humanId: null }, [], null, "Unnamed"),
    ).toBeNull();
  });
});

describe("lineupSuggestionsOf", () => {
  it("offers each act once, as a person, never the owner themselves", () => {
    const owner = {
      ref: { kind: "human" as const, id: OWNER_HUMAN },
      name: "Sam",
    };
    expect(
      lineupSuggestionsOf(
        [
          { humanId: ACT_HUMAN, displayName: "Paper Moth" },
          { humanId: ACT_HUMAN, displayName: "Paper Moth" },
          { humanId: OWNER_HUMAN, displayName: "Sam" },
          {
            humanId: "44444444-4444-4444-8444-444444444444",
            displayName: null,
          },
        ],
        owner,
        "Unnamed",
      ),
    ).toEqual([
      {
        ref: { kind: "human", id: ACT_HUMAN },
        name: "Paper Moth",
        source: "lineup",
      },
      {
        ref: { kind: "human", id: "44444444-4444-4444-8444-444444444444" },
        name: "Unnamed",
        source: "lineup",
      },
    ]);
  });
});
