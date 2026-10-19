import { describe, expect, it, vi } from "vitest";

import {
  describeVenueConfirmationState,
  hasActiveVenueConfirmationStamp,
  isVenueConfirmed,
  isVenueOwnedEvent,
  mayNameUnconfirmedVenue,
  resolveVenueConfirmationByEvent,
  resolveVenueConfirmedByEvent,
  venueConfirmationArm,
  venueConfirmedFilterFor,
} from "./venue-confirmation";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "23232323-2323-4232-8232-232323232323";
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const AT = new Date("2026-09-01T12:00:00.000Z");
const PLACE_A = "33333333-3333-4333-8333-333333333333";
const PLACE_B = "34343434-3434-4343-8343-343434343434";

const PLACE_ID = "00000000-0000-4000-8000-0000000000aa";
const place = {
  id: PLACE_ID,
  orgIdsWithAccess: [ORG_ID],
  humanIdsWithAccess: [HUMAN_ID],
  acceptsCommunityListings: false,
};

describe("isVenueOwnedEvent", () => {
  it("an event owned by an owning org is venue-owned", () => {
    expect(isVenueOwnedEvent({ orgId: ORG_ID, humanId: null }, place)).toBe(true);
  });

  it("an event owned by a direct human owner is venue-owned", () => {
    expect(isVenueOwnedEvent({ orgId: null, humanId: HUMAN_ID }, place)).toBe(true);
  });

  it("a third-party org or human is NOT venue-owned", () => {
    expect(isVenueOwnedEvent({ orgId: OTHER_ORG_ID, humanId: null }, place)).toBe(false);
    expect(isVenueOwnedEvent({ orgId: null, humanId: OTHER_HUMAN_ID }, place)).toBe(false);
  });

  it("an ownerless (community) event is never venue-owned, even against an ownerless place", () => {
    expect(isVenueOwnedEvent({ orgId: null, humanId: null }, place)).toBe(false);
    expect(
      isVenueOwnedEvent(
        { orgId: null, humanId: null },
        { orgIdsWithAccess: [], humanIdsWithAccess: [] },
      ),
    ).toBe(false);
  });

  it("treats undefined owner ids as null", () => {
    expect(isVenueOwnedEvent({}, place)).toBe(false);
  });
});

describe("hasActiveVenueConfirmationStamp", () => {
  it("stamped and not withdrawn", () => {
    expect(
      hasActiveVenueConfirmationStamp({
        placeId: PLACE_A, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT,
        venueConfirmationWithdrawnAt: null,
      }),
    ).toBe(true);
  });

  it("withdrawn = not stamped, even with venueConfirmedAt kept as history", () => {
    expect(
      hasActiveVenueConfirmationStamp({
        placeId: PLACE_A, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT,
        venueConfirmationWithdrawnAt: AT,
      }),
    ).toBe(false);
  });

  it("never confirmed = not stamped; undefined columns read as null", () => {
    expect(
      hasActiveVenueConfirmationStamp({
        placeId: PLACE_A,
        venueConfirmedAt: null,
        venueConfirmationWithdrawnAt: null,
        venueConfirmedPlaceId: null,
      }),
    ).toBe(false);
    expect(hasActiveVenueConfirmationStamp({ placeId: PLACE_A })).toBe(false);
  });

  it("H1: a stamp issued for place A is not live while the event sits at place B, and revives when it moves back", () => {
    const stampedForA = { venueConfirmedAt: AT, venueConfirmationWithdrawnAt: null, venueConfirmedPlaceId: PLACE_A };
    expect(hasActiveVenueConfirmationStamp({ ...stampedForA, placeId: PLACE_B })).toBe(false);
    expect(hasActiveVenueConfirmationStamp({ ...stampedForA, placeId: PLACE_A })).toBe(true);
    expect(hasActiveVenueConfirmationStamp({ ...stampedForA, placeId: null })).toBe(false);
    // A stamp with no place binding is never live.
    expect(hasActiveVenueConfirmationStamp({ ...stampedForA, venueConfirmedPlaceId: null, placeId: PLACE_A })).toBe(false);
  });

  it("a withdrawn never-confirmed event (a decline) is not stamped", () => {
    expect(
      hasActiveVenueConfirmationStamp({
        placeId: PLACE_A,
        venueConfirmedAt: null,
        venueConfirmationWithdrawnAt: AT,
      }),
    ).toBe(false);
  });
});

describe("isVenueConfirmed", () => {
  const thirdParty = { orgId: OTHER_ORG_ID, humanId: null, placeId: PLACE_A };

  it("a third-party event with an active stamp is confirmed", () => {
    expect(
      isVenueConfirmed(
        { ...thirdParty, placeId: PLACE_A, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT, venueConfirmationWithdrawnAt: null },
        place,
      ),
    ).toBe(true);
  });

  it("a third-party event that was never stamped is NOT confirmed", () => {
    expect(
      isVenueConfirmed(
        { ...thirdParty, venueConfirmedAt: null, venueConfirmationWithdrawnAt: null },
        place,
      ),
    ).toBe(false);
  });

  it("withdrawn renders identically to never-confirmed", () => {
    expect(
      isVenueConfirmed(
        { ...thirdParty, placeId: PLACE_A, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT, venueConfirmationWithdrawnAt: AT },
        place,
      ),
    ).toBe(false);
  });

  it("a venue-owned event is confirmed by construction, stamp or not, even when withdrawn", () => {
    expect(
      isVenueConfirmed(
        { orgId: ORG_ID, humanId: null, placeId: PLACE_A, venueConfirmedAt: null, venueConfirmationWithdrawnAt: null },
        place,
      ),
    ).toBe(true);
    expect(
      isVenueConfirmed(
        { orgId: null, humanId: HUMAN_ID, placeId: PLACE_A, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT, venueConfirmationWithdrawnAt: AT },
        place,
      ),
    ).toBe(true);
  });

  it("undefined stamp columns (older projections) read as never-confirmed", () => {
    expect(isVenueConfirmed({ orgId: OTHER_ORG_ID, humanId: null, placeId: PLACE_A }, place)).toBe(false);
  });

  it("H1: a third-party stamp for place A does not confirm the event at place B; a venue-owned event at B is still its own", () => {
    expect(
      isVenueConfirmed(
        { ...thirdParty, placeId: PLACE_B, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT, venueConfirmationWithdrawnAt: null },
        place,
      ),
    ).toBe(false);
    expect(
      isVenueConfirmed({ orgId: ORG_ID, humanId: null, placeId: PLACE_B, venueConfirmedPlaceId: PLACE_A, venueConfirmedAt: AT }, place),
    ).toBe(true);
  });
});

describe("resolveVenueConfirmedByEvent (batched)", () => {
  const ev = (id: string, o: Record<string, unknown>) =>
    ({ id, orgId: null, humanId: null, placeId: PLACE_A, venueConfirmedAt: null, venueConfirmationWithdrawnAt: null, venueConfirmedPlaceId: null, ...o }) as never;

  it("reads each distinct place once and applies the rule per event; a GONE place confirms nothing — even a stamped event", async () => {
    const getById = vi.fn(async (id: string) => (id === PLACE_A ? { id, ...place } : null));
    const out = await resolveVenueConfirmedByEvent({ repos: { places: { getById } } }, [
      ev("1", { orgId: ORG_ID }),
      ev("2", { orgId: OTHER_ORG_ID }),
      ev("3", { orgId: OTHER_ORG_ID, venueConfirmedAt: AT, venueConfirmedPlaceId: PLACE_A }),
      ev("4", { orgId: ORG_ID, placeId: PLACE_B }),
      ev("5", { orgId: ORG_ID, placeId: null }),
      // Stamped for B, but B's row is gone: a deleted venue cannot vouch.
      ev("6", { orgId: OTHER_ORG_ID, placeId: PLACE_B, venueConfirmedAt: AT, venueConfirmedPlaceId: PLACE_B }),
    ]);
    expect(getById).toHaveBeenCalledTimes(2);
    expect([...out.entries()]).toEqual([["1", true], ["2", false], ["3", true], ["4", false], ["5", false], ["6", false]]);
  });

  it("a THROWING place read (row presumably exists) keeps the stamp arm, drops ownership, and reports once per place", async () => {
    const err = new Error("db down");
    const reportError = vi.fn();
    const out = await resolveVenueConfirmedByEvent(
      { repos: { places: { getById: vi.fn(async () => { throw err; }) } }, reportError },
      [ev("1", { orgId: ORG_ID }), ev("2", { orgId: ORG_ID, venueConfirmedAt: AT, venueConfirmedPlaceId: PLACE_A })],
      { useCase: "x" },
    );
    expect(out.get("1")).toBe(false);
    expect(out.get("2")).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err, { tags: { useCase: "x", step: "resolveVenueConfirmedByEvent" }, extra: { placeId: PLACE_A } });
    const throwing = vi.fn(() => { throw new Error("sentry down"); });
    await expect(
      resolveVenueConfirmedByEvent({ repos: { places: { getById: vi.fn(async () => { throw err; }) } }, reportError: throwing }, [ev("1", { orgId: ORG_ID })]),
    ).resolves.toBeInstanceOf(Map);
  });
});

describe("venueConfirmedFilterFor", () => {
  it("is the place's owner id sets, so the SQL predicate matches the TS derivation", () => {
    expect(venueConfirmedFilterFor(place)).toEqual({
      orgIds: [ORG_ID],
      humanIds: [HUMAN_ID],
      acceptsCommunityListings: false,
    });
  });

  it("copies the arrays — the place record cannot be mutated through the filter", () => {
    const filter = venueConfirmedFilterFor(place);
    filter.orgIds.push(OTHER_ORG_ID);
    filter.humanIds.push(OTHER_HUMAN_ID);
    expect(place.orgIdsWithAccess).toEqual([ORG_ID]);
    expect(place.humanIdsWithAccess).toEqual([HUMAN_ID]);
  });

  it("empty owner sets are valid and match no owner", () => {
    expect(
      venueConfirmedFilterFor({
        id: PLACE_ID,
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        acceptsCommunityListings: false,
      }),
    ).toEqual({ orgIds: [], humanIds: [], acceptsCommunityListings: false });
  });

  it("carries the place's community consent through to the SQL filter", () => {
    expect(
      venueConfirmedFilterFor({ ...place, acceptsCommunityListings: true }),
    ).toEqual({
      orgIds: [ORG_ID],
      humanIds: [HUMAN_ID],
      acceptsCommunityListings: true,
    });
  });
});

describe("describeVenueConfirmationState", () => {
  const PLACE = "place-1";
  const base = {
    orgId: null,
    humanId: "human-requester",
    placeId: PLACE,
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
  };
  const owners = { orgIdsWithAccess: ["org-venue"], humanIdsWithAccess: [] };

  it("a place-owned event is confirmed by construction, ownerSide place", () => {
    expect(
      describeVenueConfirmationState({ ...base, orgId: "org-venue", humanId: null }, owners),
    ).toEqual({ state: "confirmed", ownerSide: "place" });
  });

  it("an active stamp for this place confirms a requester-owned event", () => {
    expect(
      describeVenueConfirmationState(
        { ...base, venueConfirmedAt: new Date(), venueConfirmedPlaceId: PLACE },
        owners,
      ),
    ).toEqual({ state: "confirmed", ownerSide: "requester" });
  });

  it("a withdrawn stamp reads withdrawn — the admin-side distinction", () => {
    expect(
      describeVenueConfirmationState(
        {
          ...base,
          venueConfirmedAt: new Date(),
          venueConfirmedPlaceId: PLACE,
          venueConfirmationWithdrawnAt: new Date(),
        },
        owners,
      ).state,
    ).toBe("withdrawn");
  });

  it("no stamp, not venue-owned = unconfirmed; a stamp for another place too", () => {
    expect(describeVenueConfirmationState(base, owners).state).toBe("unconfirmed");
    expect(
      describeVenueConfirmationState(
        { ...base, venueConfirmedAt: new Date(), venueConfirmedPlaceId: "elsewhere" },
        owners,
      ).state,
    ).toBe("unconfirmed");
  });

  it("a gone place (null owners) keeps a stamp the venue issued", () => {
    expect(
      describeVenueConfirmationState(
        { ...base, venueConfirmedAt: new Date(), venueConfirmedPlaceId: PLACE },
        null,
      ),
    ).toEqual({ state: "confirmed", ownerSide: "requester" });
  });
});

// ── venueConfirmationArm: WHICH arm holds (the holder-address gate reads it) ──

describe("venueConfirmationArm", () => {
  const stamped = {
    venueConfirmedAt: AT,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: PLACE_ID,
  };
  const consenting = { ...place, acceptsCommunityListings: true };

  it("owner: the venue's own show", () => {
    expect(
      venueConfirmationArm(
        { orgId: ORG_ID, humanId: null, placeId: PLACE_ID, stewardship: "OWNED" },
        place,
      ),
    ).toBe("owner");
    expect(
      venueConfirmationArm(
        { orgId: null, humanId: HUMAN_ID, placeId: PLACE_ID, stewardship: "OWNED" },
        place,
      ),
    ).toBe("owner");
  });

  it("owner beats a stamp (a venue-owned row with a stray stamp is still its own show)", () => {
    expect(
      venueConfirmationArm(
        { orgId: ORG_ID, humanId: null, placeId: PLACE_ID, stewardship: "OWNED", ...stamped },
        place,
      ),
    ).toBe("owner");
  });

  it("stamp: a third party the venue confirmed, stamp live and bound to this place", () => {
    expect(
      venueConfirmationArm(
        { orgId: OTHER_ORG_ID, humanId: null, placeId: PLACE_ID, stewardship: "OWNED", ...stamped },
        place,
      ),
    ).toBe("stamp");
  });

  it("a withdrawn stamp, or one issued for another place, is no arm at all", () => {
    expect(
      venueConfirmationArm(
        {
          orgId: OTHER_ORG_ID,
          humanId: null,
          placeId: PLACE_ID,
          stewardship: "OWNED",
          ...stamped,
          venueConfirmationWithdrawnAt: AT,
        },
        place,
      ),
    ).toBeNull();
    expect(
      venueConfirmationArm(
        {
          orgId: OTHER_ORG_ID,
          humanId: null,
          placeId: PLACE_ID,
          stewardship: "OWNED",
          ...stamped,
          venueConfirmedPlaceId: PLACE_B,
        },
        place,
      ),
    ).toBeNull();
  });

  it("community: an ownerless listing accepted by blanket consent", () => {
    expect(
      venueConfirmationArm(
        { orgId: null, humanId: null, placeId: PLACE_ID, stewardship: "COMMUNITY" },
        consenting,
      ),
    ).toBe("community");
  });

  it("a stamped community listing reads as stamp (the venue confirmed it by hand)", () => {
    expect(
      venueConfirmationArm(
        { orgId: null, humanId: null, placeId: PLACE_ID, stewardship: "COMMUNITY", ...stamped },
        consenting,
      ),
    ).toBe("stamp");
  });

  it("an unconfirmed third party is null", () => {
    expect(
      venueConfirmationArm(
        { orgId: OTHER_ORG_ID, humanId: null, placeId: PLACE_ID, stewardship: "OWNED" },
        place,
      ),
    ).toBeNull();
  });

  it("fails closed without a place row, even for a stamped event", () => {
    const event = {
      orgId: ORG_ID,
      humanId: null,
      placeId: PLACE_ID,
      stewardship: "OWNED" as const,
      ...stamped,
    };
    expect(venueConfirmationArm(event, null)).toBeNull();
    expect(venueConfirmationArm(event, undefined)).toBeNull();
  });

  it("INVARIANT: an arm holds exactly when isVenueConfirmed does", () => {
    const owners = [
      { orgId: ORG_ID, humanId: null },
      { orgId: null, humanId: HUMAN_ID },
      { orgId: OTHER_ORG_ID, humanId: null },
      { orgId: null, humanId: null },
    ];
    const stamps = [
      {},
      stamped,
      { ...stamped, venueConfirmationWithdrawnAt: AT },
      { ...stamped, venueConfirmedPlaceId: PLACE_B },
      { venueConfirmedAt: null, venueConfirmationWithdrawnAt: AT },
    ];
    const stewardships = ["OWNED", "COMMUNITY"] as const;
    const placeIds = [PLACE_ID, PLACE_B, null];
    const places = [place, consenting, { ...consenting, id: PLACE_B }];
    let checked = 0;
    for (const owner of owners)
      for (const stamp of stamps)
        for (const stewardship of stewardships)
          for (const placeId of placeIds)
            for (const p of places) {
              const event = { ...owner, ...stamp, stewardship, placeId };
              expect(venueConfirmationArm(event, p) !== null).toBe(
                isVenueConfirmed(event, p),
              );
              checked += 1;
            }
    expect(checked).toBe(4 * 5 * 2 * 3 * 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Name-only display (owner ruling 2026-10-06, option B): an unconfirmed
// COMMUNITY listing may show its place's name as plain text. Separate from
// confirmation — isVenueConfirmed must not move.
// ─────────────────────────────────────────────────────────────────────────────
describe("mayNameUnconfirmedVenue", () => {
  const unownedActive = {
    id: PLACE_ID,
    orgIdsWithAccess: [] as string[],
    humanIdsWithAccess: [] as string[],
    acceptsCommunityListings: false,
    status: "ACTIVE" as const,
    listedInDirectory: true,
  };
  const ownedActive = {
    ...unownedActive,
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [HUMAN_ID],
  };
  const community = {
    orgId: null,
    humanId: null,
    placeId: PLACE_ID,
    stewardship: "COMMUNITY" as const,
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
  };

  it("base case: unconfirmed community listing at an ACTIVE place → may name", () => {
    expect(isVenueConfirmed(community, unownedActive)).toBe(false);
    expect(mayNameUnconfirmedVenue(community, unownedActive)).toBe(true);
    expect(isVenueConfirmed(community, ownedActive)).toBe(false);
    expect(mayNameUnconfirmedVenue(community, ownedActive)).toBe(true);
  });

  it("OWNED stewardship (third-party event) → no", () => {
    const owned = { ...community, orgId: OTHER_ORG_ID, stewardship: "OWNED" as const };
    expect(isVenueConfirmed(owned, unownedActive)).toBe(false);
    expect(mayNameUnconfirmedVenue(owned, unownedActive)).toBe(false);
  });

  it("no placeId, or a placeId that is not this place → no", () => {
    expect(mayNameUnconfirmedVenue({ ...community, placeId: null }, unownedActive)).toBe(false);
    expect(mayNameUnconfirmedVenue({ ...community, placeId: PLACE_B }, unownedActive)).toBe(false);
  });

  it("withdrawn → no (a venue that rejected the listing is not named)", () => {
    expect(
      mayNameUnconfirmedVenue({ ...community, venueConfirmationWithdrawnAt: AT }, ownedActive),
    ).toBe(false);
    expect(
      mayNameUnconfirmedVenue({ ...community, venueConfirmationWithdrawnAt: AT }, unownedActive),
    ).toBe(false);
  });

  it("SUSPENDED or ARCHIVED place → no", () => {
    expect(mayNameUnconfirmedVenue(community, { ...unownedActive, status: "SUSPENDED" })).toBe(false);
    expect(mayNameUnconfirmedVenue(community, { ...unownedActive, status: "ARCHIVED" })).toBe(false);
  });

  it("owned + listedInDirectory=false → no (the owner opted out)", () => {
    expect(mayNameUnconfirmedVenue(community, { ...ownedActive, listedInDirectory: false })).toBe(false);
    // Either kind of owner counts as "owned".
    expect(
      mayNameUnconfirmedVenue(community, {
        ...unownedActive,
        humanIdsWithAccess: [HUMAN_ID],
        listedInDirectory: false,
      }),
    ).toBe(false);
  });

  it("UNOWNED + listedInDirectory=false → yes (bulk-import default, nobody chose it)", () => {
    expect(mayNameUnconfirmedVenue(community, { ...unownedActive, listedInDirectory: false })).toBe(true);
  });

  it("confirmed → false: the confirmed path owns the name (and the link)", () => {
    const consenting = { ...ownedActive, acceptsCommunityListings: true };
    expect(isVenueConfirmed(community, consenting)).toBe(true);
    expect(mayNameUnconfirmedVenue(community, consenting)).toBe(false);
    const stamped = { ...community, venueConfirmedAt: AT, venueConfirmedPlaceId: PLACE_ID };
    expect(isVenueConfirmed(stamped, ownedActive)).toBe(true);
    expect(mayNameUnconfirmedVenue(stamped, ownedActive)).toBe(false);
  });
});

describe("resolveVenueConfirmationByEvent — displayPlaceName", () => {
  const base = {
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY" as const,
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
  };
  const placeRow = (over: Record<string, unknown> = {}) => ({
    id: PLACE_A,
    name: "The Basement East",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    status: "ACTIVE",
    listedInDirectory: false,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    ...over,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const depsFor = (row: any) => ({
    repos: { places: { getById: vi.fn(async () => row) } },
  });

  it("name-only: displayPlaceName set, placeName and confirmed unchanged (null / false)", async () => {
    const out = await resolveVenueConfirmationByEvent(depsFor(placeRow()), [
      { id: "e1", placeId: PLACE_A, ...base },
    ]);
    const r = out.get("e1")!;
    expect(r.confirmed).toBe(false);
    expect(r.placeName).toBeNull();
    expect(r.displayPlaceName).toBe("The Basement East");
  });

  it("confirmed: displayPlaceName equals placeName", async () => {
    const out = await resolveVenueConfirmationByEvent(
      depsFor(placeRow({ orgIdsWithAccess: [ORG_ID], acceptsCommunityListings: true })),
      [{ id: "e1", placeId: PLACE_A, ...base }],
    );
    const r = out.get("e1")!;
    expect(r.confirmed).toBe(true);
    expect(r.placeName).toBe("The Basement East");
    expect(r.displayPlaceName).toBe("The Basement East");
  });

  it("re-linked listing: the name follows the CURRENT placeId (no cached name)", async () => {
    const getById = vi.fn(async (id: string) =>
      id === PLACE_A
        ? placeRow()
        : id === PLACE_B
          ? placeRow({ id: PLACE_B, name: "Corner Bar" })
          : null,
    );
    const deps = { repos: { places: { getById } } };
    const before = await resolveVenueConfirmationByEvent(deps as never, [
      { id: "e1", placeId: PLACE_A, ...base },
    ]);
    const after = await resolveVenueConfirmationByEvent(deps as never, [
      { id: "e1", placeId: PLACE_B, ...base },
    ]);
    expect(before.get("e1")!.displayPlaceName).toBe("The Basement East");
    expect(after.get("e1")!.displayPlaceName).toBe("Corner Bar");
  });

  it("not granted (withdrawn / third-party / gone / read threw) → displayPlaceName null", async () => {
    const withdrawn = await resolveVenueConfirmationByEvent(depsFor(placeRow()), [
      { id: "e1", placeId: PLACE_A, ...base, venueConfirmationWithdrawnAt: AT },
    ]);
    expect(withdrawn.get("e1")!.displayPlaceName).toBeNull();

    const thirdParty = await resolveVenueConfirmationByEvent(depsFor(placeRow()), [
      { id: "e1", placeId: PLACE_A, ...base, orgId: OTHER_ORG_ID, stewardship: "OWNED" },
    ]);
    expect(thirdParty.get("e1")!.displayPlaceName).toBeNull();

    const gone = await resolveVenueConfirmationByEvent(depsFor(null), [
      { id: "e1", placeId: PLACE_A, ...base },
    ]);
    expect(gone.get("e1")!.displayPlaceName).toBeNull();

    const threw = await resolveVenueConfirmationByEvent(
      {
        repos: {
          places: {
            getById: vi.fn(async () => {
              throw new Error("db down");
            }),
          },
        },
      },
      [{ id: "e1", placeId: PLACE_A, ...base }],
    );
    expect(threw.get("e1")!.displayPlaceName).toBeNull();
    expect(threw.get("e1")!.confirmed).toBe(false);
  });
});
