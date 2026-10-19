import { describe, expect, it } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";

import { deriveCounterparty } from "./accept-in-tx";
import {
  deriveVenueBookingParty,
  ownerContextForVenueBookingParty,
} from "./venue-booking-party";

// ─────────────────────────────────────────────────────────────────────────────
// FR-006 — the venue side of a booking, derived from the PLACE and never from
// a fallback. One party is both the Agreement's counterparty and the Event's
// owner, so every case here is simultaneously "who signs" and "whose show it
// is".
//
// The last block pins this against `deriveCounterparty`, the derivation the
// live accept / confirm paths still use, so the two cannot drift while both
// exist (FR-001 retires the older one; this change deliberately does not).
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_A = "11111111-0000-4000-8000-00000000000a";
const ORG_B = "22222222-0000-4000-8000-00000000000b";
const OWNER_A = "aaaa1111-0000-4000-8000-00000000000a";
const OWNER_B = "bbbb2222-0000-4000-8000-00000000000b";
const GRANTEE = "9999cccc-0000-4000-8000-00000000000c";

function place(
  orgIdsWithAccess: string[],
  humanIdsWithAccess: string[],
): Pick<PlaceRecord, "id" | "orgIdsWithAccess" | "humanIdsWithAccess"> {
  return { id: PLACE_ID, orgIdsWithAccess, humanIdsWithAccess };
}

describe("deriveVenueBookingParty (FR-006)", () => {
  it("rule 1 — an org member's accept mints under the ORG, not the person", () => {
    expect(
      deriveVenueBookingParty(
        { via: "org", orgId: ORG_A },
        place([ORG_A], []),
        OWNER_A,
      ),
    ).toEqual({ type: "organization", id: ORG_A });
  });

  it("rule 2 — a DIRECT human owner gets themselves", () => {
    expect(
      deriveVenueBookingParty(
        { via: "human", orgId: null },
        place([], [OWNER_A]),
        OWNER_A,
      ),
    ).toEqual({ type: "human", id: OWNER_A });
  });

  it("rule 2 — a CO-OWNED place mints under the co-owner who accepted, not the smallest id", () => {
    // The failure this rule exists to prevent: with the claim path's
    // smallest-id pick, co-owner B's accept would mint under A and then fail
    // B's own mint with NOT_RESOURCE_OWNER.
    const coOwned = place([], [OWNER_A, OWNER_B]);

    expect(
      deriveVenueBookingParty({ via: "human", orgId: null }, coOwned, OWNER_B),
    ).toEqual({ type: "human", id: OWNER_B });
    expect(
      deriveVenueBookingParty({ via: "human", orgId: null }, coOwned, OWNER_A),
    ).toEqual({ type: "human", id: OWNER_A });
  });

  // holds-without-a-request FR-002 retired the GRANTEE rules: the staff gate
  // has no grant arm, so `via: "grant"` is never an input any more (was:
  // rule 1's grantee half → the owning org; rule 3 → the place's smallest
  // human owner). A grantee who is not on either list is refused here like
  // any uncorroborated actor.
  it("rule 4 — refuses with NOT_RESOURCE_OWNER when no party can be derived (an actor on neither list)", () => {
    expect(() =>
      deriveVenueBookingParty(
        { via: "human", orgId: null },
        place([], []),
        GRANTEE,
      ),
    ).toThrowError(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });

  it("is a CHECK, not a fallback: an `ownership` the place record does not corroborate is refused", () => {
    // FR-006's complaint about the old derivation, closed. `via: "human"` for
    // someone who owns nothing here, and `via: "org"` naming an org that does
    // not own this place, both used to hand back an unverified party.
    expect(() =>
      deriveVenueBookingParty(
        { via: "human", orgId: null },
        place([], [OWNER_A]),
        GRANTEE,
      ),
    ).toThrowError(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));

    expect(() =>
      deriveVenueBookingParty(
        { via: "org", orgId: ORG_B },
        place([ORG_A], []),
        OWNER_A,
      ),
    ).toThrowError(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });

  it("org-vs-human: the org wins for a member, the person wins for a direct owner", () => {
    // The one case FR-006's literal "org-owned → the org, regardless" and the
    // landed `deriveCounterparty` read differently, pinned deliberately. A
    // place owned by BOTH an org and a person:
    const dual = place([ORG_A], [OWNER_A]);

    // ...the direct human owner → THEMSELVES. `resolvePlaceOwnership` answers
    // `via: "human"` without ever looking up an org membership, so minting
    // under the org would hand a person's booking to an organisation they may
    // hold no role in — and they would then fail NOT_RESOURCE_OWNER editing
    // the event they just created.
    expect(
      deriveVenueBookingParty({ via: "human", orgId: null }, dual, OWNER_A),
    ).toEqual({ type: "human", id: OWNER_A });

    // ...and a member of the owning org → the org.
    expect(
      deriveVenueBookingParty({ via: "org", orgId: ORG_A }, dual, GRANTEE),
    ).toEqual({ type: "organization", id: ORG_A });
  });

  it("the derived party is ALWAYS on one of the place's access lists", () => {
    // The invariant the accept mint's attach gate leans on: a party off the
    // lists would take the save's THIRD-PARTY arm, which creates a
    // BookingRequest inside the caller's transaction.
    const cases: Array<
      [Parameters<typeof deriveVenueBookingParty>[0], string[], string[], string]
    > = [
      [{ via: "org", orgId: ORG_A }, [ORG_A], [], OWNER_A],
      [{ via: "human", orgId: null }, [ORG_A], [OWNER_A, OWNER_B], OWNER_B],
      [{ via: "org", orgId: ORG_B }, [ORG_A, ORG_B], [], OWNER_A],
      [{ via: "human", orgId: null }, [], [OWNER_B, OWNER_A], OWNER_A],
    ];

    for (const [ownership, orgIds, humanIds, actor] of cases) {
      const row = place(orgIds, humanIds);
      const party = deriveVenueBookingParty(ownership, row, actor);
      const list =
        party.type === "organization"
          ? row.orgIdsWithAccess
          : row.humanIdsWithAccess;
      expect(list).toContain(party.id);
    }
  });
});

describe("ownerContextForVenueBookingParty", () => {
  it("translates the party into the save's owner vocabulary", () => {
    expect(
      ownerContextForVenueBookingParty({ type: "organization", id: ORG_A }),
    ).toEqual({ kind: "org", orgId: ORG_A });
    expect(
      ownerContextForVenueBookingParty({ type: "human", id: OWNER_A }),
    ).toEqual({ kind: "human", humanId: OWNER_A });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The two derivations live side by side until FR-001 retires the older one.
// This block is the guard against them drifting apart in the meantime.
// ─────────────────────────────────────────────────────────────────────────────
describe("agreement with `deriveCounterparty` on every well-formed input", () => {
  const wellFormed: Array<{
    name: string;
    ownership: Parameters<typeof deriveVenueBookingParty>[0];
    orgIds: string[];
    humanIds: string[];
    actor: string;
  }> = [
    {
      name: "org member",
      ownership: { via: "org", orgId: ORG_A },
      orgIds: [ORG_A],
      humanIds: [],
      actor: OWNER_A,
    },
    {
      name: "direct human owner",
      ownership: { via: "human", orgId: null },
      orgIds: [],
      humanIds: [OWNER_A],
      actor: OWNER_A,
    },
    {
      name: "co-owner B",
      ownership: { via: "human", orgId: null },
      orgIds: [],
      humanIds: [OWNER_A, OWNER_B],
      actor: OWNER_B,
    },
    {
      name: "dual-access direct owner",
      ownership: { via: "human", orgId: null },
      orgIds: [ORG_A],
      humanIds: [OWNER_A],
      actor: OWNER_A,
    },
  ];

  for (const scenario of wellFormed) {
    it(`agrees for: ${scenario.name}`, () => {
      const row = place(scenario.orgIds, scenario.humanIds);
      expect(
        deriveVenueBookingParty(scenario.ownership, row, scenario.actor),
      ).toEqual(deriveCounterparty(scenario.ownership, row, scenario.actor));
    });
  }

  it("agrees for: a direct owner whose authority came back as `org`", () => {
    // Both functions answer this by their rule 1 (`via === "org"` wins before
    // anything else looks at the lists), so it pins agreement rather than
    // guarding drift — the case that actually diverges is the next one.
    const row = place([ORG_A], [OWNER_A]);
    expect(
      deriveVenueBookingParty({ via: "org", orgId: ORG_A }, row, OWNER_A),
    ).toEqual(deriveCounterparty({ via: "org", orgId: ORG_A }, row, OWNER_A));
  });

  // (The `via: "grant"` divergence case went with the grant arm,
  // holds-without-a-request FR-002: no gate produces it.)
  it("refuses together when the place has no owner at all", () => {
    const row = place([], []);
    const noAccess = { via: "org" as const, orgId: null };
    expect(() =>
      deriveVenueBookingParty(noAccess, row, GRANTEE),
    ).toThrowError(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
    expect(() =>
      deriveCounterparty(noAccess, row, GRANTEE),
    ).toThrowError(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });
});
