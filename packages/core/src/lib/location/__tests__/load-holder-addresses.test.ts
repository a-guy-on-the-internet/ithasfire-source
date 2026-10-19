import { describe, expect, it, vi } from "vitest";

import {
  eventIdsWithAddress,
  gatedRowAddressText,
  loadHolderAddressesForEventIds,
  resolveHolderAddressesForEvents,
} from "../load-holder-addresses";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const VENUE_ORG = "org-house";

/** A withheld venue, shaped like the `PlaceRecord` `places.getById` returns. */
const withheldPlace = {
  id: "place-1",
  formattedAddress: "901 Porter Rd",
  city: "Nashville",
  postalCode: "37206",
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  orgIdsWithAccess: [VENUE_ORG],
  humanIdsWithAccess: [],
  acceptsCommunityListings: true,
};

const exact = {
  id: "e-exact",
  placeId: null,
  orgId: "org-x",
  humanId: null,
  stewardship: "OWNED" as const,
  locationMode: "EXACT",
  addressText: "1114 Fatherland St",
};
/** The venue's own show, revealed an hour ago (IMMEDIATELY). */
const atVenueA = {
  id: "e-a",
  placeId: "place-1",
  orgId: VENUE_ORG,
  humanId: null,
  stewardship: "OWNED" as const,
  locationMode: "OBSCURED",
  addressRevealPreset: "IMMEDIATELY",
  addressRevealAt: new Date(NOW.getTime() - HOUR),
  addressText: "East Nashville",
  locality: "Nashville",
  region: "TN",
  startsAt: new Date(NOW.getTime() + 14 * DAY),
};
const atVenueB = { ...atVenueA, id: "e-b" };
/** C1: somebody else's event attached to the house, IMMEDIATELY, unconfirmed. */
const thirdParty = { ...atVenueA, id: "e-third", orgId: "org-stranger" };
/** The same, but the venue confirmed it by hand. */
const stampedThirdParty = {
  ...thirdParty,
  id: "e-stamped",
  venueConfirmedAt: new Date(NOW.getTime() - DAY),
  venueConfirmationWithdrawnAt: null,
  venueConfirmedPlaceId: "place-1",
};
/** An ownerless listing at a house that accepts community listings. */
const communityListing = {
  ...atVenueA,
  id: "e-community",
  orgId: null,
  stewardship: "COMMUNITY" as const,
};
const never = {
  id: "e-never",
  placeId: null,
  orgId: "org-x",
  humanId: null,
  stewardship: "OWNED" as const,
  locationMode: "OBSCURED",
  addressRevealPreset: "NEVER",
  addressRevealAt: null,
  addressText: "2 Secret Ln",
  locality: "Nashville",
  region: "TN",
};

describe("resolveHolderAddressesForEvents", () => {
  it("reads each DISTINCT venue once and resolves every event", async () => {
    const getById = vi.fn(async () => withheldPlace);
    const out = await resolveHolderAddressesForEvents({
      repos: { places: { getById } } as never,
      events: [exact, atVenueA, atVenueB, never],
      activeHolder: true,
      now: NOW,
    });
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenCalledWith("place-1");
    expect(out.get("e-exact")).toMatchObject({ locked: false, addressText: "1114 Fatherland St" });
    expect(out.get("e-a")).toMatchObject({ locked: false, source: "PLACE", addressText: "901 Porter Rd" });
    expect(out.get("e-b")).toMatchObject({ locked: false, source: "PLACE" });
    expect(out.get("e-never")).toMatchObject({ locked: true, never: true, label: "Nashville, TN" });
  });

  it("derives HOW the venue vouched from the same row: owner releases, unconfirmed and community never do, stamp waits", async () => {
    const out = await resolveHolderAddressesForEvents({
      repos: { places: { getById: vi.fn(async () => withheldPlace) } } as never,
      events: [atVenueA, thirdParty, communityListing, stampedThirdParty],
      activeHolder: true,
      now: NOW,
    });
    expect(out.get("e-a")).toMatchObject({ locked: false, source: "PLACE" });
    expect(out.get("e-third")).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
    expect(out.get("e-community")).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
    expect(out.get("e-stamped")).toMatchObject({
      locked: true,
      reason: "notYetRevealed",
      revealAt: new Date(stampedThirdParty.startsAt.getTime() - DAY),
    });
    for (const id of ["e-third", "e-community", "e-stamped"]) {
      expect(JSON.stringify(out.get(id))).not.toContain("Porter");
    }
  });

  it("a caller that cannot vouch for its viewers gets no street", async () => {
    const out = await resolveHolderAddressesForEvents({
      repos: { places: { getById: vi.fn(async () => withheldPlace) } } as never,
      events: [atVenueA],
      activeHolder: false,
      now: NOW,
    });
    expect(out.get("e-a")).toMatchObject({ locked: true, reason: "notHolder" });
  });

  it("a per-event answer gates each event on its own, with one venue read", async () => {
    const getById = vi.fn(async () => withheldPlace);
    const out = await resolveHolderAddressesForEvents({
      repos: { places: { getById } } as never,
      events: [atVenueA, atVenueB],
      activeHolder: (event) => event.id === "e-a",
      now: NOW,
    });
    expect(getById).toHaveBeenCalledTimes(1);
    expect(out.get("e-a")).toMatchObject({ locked: false, source: "PLACE" });
    expect(out.get("e-b")).toMatchObject({ locked: true, reason: "notHolder" });
    expect(JSON.stringify(out.get("e-b"))).not.toContain("Porter");
  });

  it("does not swallow a failed venue read", async () => {
    const getById = vi.fn(async () => {
      throw new Error("places down");
    });
    await expect(
      resolveHolderAddressesForEvents({
        repos: { places: { getById } },
        events: [atVenueA],
        activeHolder: true,
        now: NOW,
      }),
    ).rejects.toThrow("places down");
  });
});

describe("loadHolderAddressesForEventIds", () => {
  it("reads nothing when there are no ids", async () => {
    const findManyByIds = vi.fn();
    const out = await loadHolderAddressesForEventIds({
      repos: { events: { findManyByIds }, places: { getById: vi.fn() } },
      eventIds: [null, undefined, ""],
      activeHolder: true,
      now: NOW,
    });
    expect(out.size).toBe(0);
    expect(findManyByIds).not.toHaveBeenCalled();
  });

  it("de-duplicates ids and leaves a vanished event absent", async () => {
    const findManyByIds = vi.fn(async () => [exact] as never);
    const out = await loadHolderAddressesForEventIds({
      repos: { events: { findManyByIds }, places: { getById: vi.fn() } },
      eventIds: ["e-exact", "e-exact", "e-gone"],
      activeHolder: true,
      now: NOW,
    });
    expect(findManyByIds).toHaveBeenCalledWith(["e-exact", "e-gone"]);
    expect(out.has("e-exact")).toBe(true);
    expect(out.has("e-gone")).toBe(false);
  });
});

describe("gatedRowAddressText / eventIdsWithAddress", () => {
  it("never adds an address to a row that had none, and fails closed on a missing event", async () => {
    const addresses = await resolveHolderAddressesForEvents({
      repos: { places: { getById: vi.fn() } },
      events: [exact, never],
      activeHolder: true,
      now: NOW,
    });
    const holder = { activeHolder: true };
    expect(gatedRowAddressText({ eventId: "e-exact", addressText: null }, addresses, holder)).toBeNull();
    expect(gatedRowAddressText({ eventId: null, addressText: "x" }, addresses, holder)).toBeNull();
    expect(gatedRowAddressText({ eventId: "e-gone", addressText: "x" }, addresses, holder)).toBeNull();
    expect(gatedRowAddressText({ eventId: "e-exact", addressText: "x" }, addresses, holder)).toBe(
      "1114 Fatherland St",
    );
    expect(gatedRowAddressText({ eventId: "e-never", addressText: "x" }, addresses, holder)).toBe(
      "Nashville, TN",
    );
    expect(
      eventIdsWithAddress([
        { eventId: "a", addressText: "x" },
        { eventId: "b", addressText: null },
        { eventId: null, addressText: "y" },
      ]),
    ).toEqual(["a"]);
  });

  it("a row whose viewer is not a holder gets nothing, not even the label", async () => {
    const addresses = await resolveHolderAddressesForEvents({
      repos: { places: { getById: vi.fn() } },
      events: [exact, never],
      activeHolder: true,
      now: NOW,
    });
    const notHolder = { activeHolder: false };
    expect(gatedRowAddressText({ eventId: "e-exact", addressText: "x" }, addresses, notHolder)).toBeNull();
    expect(gatedRowAddressText({ eventId: "e-never", addressText: "x" }, addresses, notHolder)).toBeNull();
  });
});
