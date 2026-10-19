import { describe, expect, it } from "vitest";

import type { EventRecord } from "@th/ports/repos";

/**
 * Shared regression cases for the DB-backed event-card lists (owner ruling
 * 2026-10-07): a card prints an UNCONFIRMED community listing's venue name as
 * plain text under the event page's gate (`mayNameUnconfirmedVenue`), and
 * nothing else changes. Each list's test file supplies how to build its event
 * and how to run its use case, and gets the same four cases.
 */
const PLACE_ID = "11111111-1111-4111-8111-111111111111";

const makePlace = (overrides: Record<string, unknown> = {}) => ({
  id: PLACE_ID,
  name: "The Shelby House",
  status: "ACTIVE",
  listedInDirectory: false, // the bulk-import default nobody chose
  orgIdsWithAccess: [] as string[],
  humanIdsWithAccess: [] as string[],
  acceptsCommunityListings: false, // so the listing is NOT confirmed
  locationMode: "EXACT",
  formattedAddress: "1 Main St, Nashville, TN",
  city: "Nashville",
  region: "TN",
  ...overrides,
});

export type CardVenueNameHarness = {
  /** A fresh EventRecord from the file's own factory. */
  makeEvent: () => EventRecord;
  /** Runs the use case with `place` behind `places.getById`; returns the card's `placeName`. */
  cardPlaceName: (event: EventRecord, place: unknown) => Promise<string | null>;
};

export function describeCardVenueName(h: CardVenueNameHarness): void {
  const communityEvent = (extra: Record<string, unknown> = {}) =>
    Object.assign(h.makeEvent(), {
      placeId: PLACE_ID,
      stewardship: "COMMUNITY",
      orgId: null,
      humanId: null,
      locationMode: "EXACT",
      ...extra,
    }) as EventRecord;

  describe("card venue label (unconfirmed community venue, name only)", () => {
    it("names an unconfirmed community listing's ACTIVE, unowned place", async () => {
      await expect(
        h.cardPlaceName(communityEvent(), makePlace()),
      ).resolves.toBe("The Shelby House");
    });

    it("a non-community (OWNED) unconfirmed event still gets no name", async () => {
      const owned = communityEvent({
        stewardship: "OWNED",
        orgId: "22222222-2222-4222-8222-222222222222",
      });
      await expect(h.cardPlaceName(owned, makePlace())).resolves.toBeNull();
    });

    it("a withdrawn confirmation gets no name", async () => {
      const withdrawn = communityEvent({
        venueConfirmationWithdrawnAt: new Date("2026-01-01T00:00:00Z"),
      });
      await expect(h.cardPlaceName(withdrawn, makePlace())).resolves.toBeNull();
    });

    it("an unconfirmed name never undoes an OBSCURED public location", async () => {
      const obscured = communityEvent({
        locationMode: "OBSCURED",
        locationRadiusMeters: null,
      });
      await expect(h.cardPlaceName(obscured, makePlace())).resolves.toBeNull();
    });

    it("an OWNED place that opted out of the directory gets no name", async () => {
      const owned = makePlace({
        orgIdsWithAccess: ["33333333-3333-4333-8333-333333333333"],
        listedInDirectory: false,
      });
      await expect(
        h.cardPlaceName(communityEvent(), owned),
      ).resolves.toBeNull();
    });

    it("a gated (PASSWORD) community event gets no name", async () => {
      await expect(
        h.cardPlaceName(
          communityEvent({ gateType: "PASSWORD" }),
          makePlace(),
        ),
      ).resolves.toBeNull();
    });

    it("a venue that withholds its address gets no name, even for an EXACT event", async () => {
      const withheld = makePlace({
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
      });
      await expect(
        h.cardPlaceName(communityEvent({ locationMode: "EXACT" }), withheld),
      ).resolves.toBeNull();
    });

    it("control: a CONFIRMED community listing (venue accepts them) is named", async () => {
      await expect(
        h.cardPlaceName(
          communityEvent(),
          makePlace({ acceptsCommunityListings: true }),
        ),
      ).resolves.toBe("The Shelby House");
    });

    it("an inactive place gets no name", async () => {
      await expect(
        h.cardPlaceName(communityEvent(), makePlace({ status: "ARCHIVED" })),
      ).resolves.toBeNull();
    });
  });
}
