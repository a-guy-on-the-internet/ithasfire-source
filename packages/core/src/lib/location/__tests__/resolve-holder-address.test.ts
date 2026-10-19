import { describe, expect, it } from "vitest";

import {
  holderAddressLine,
  holderRevealSchedule,
  resolveHolderAddress,
  STAMP_ARM_REVEAL_LEAD_MS,
  type HolderAddressEventSource,
  type ResolveHolderAddressInput,
} from "../resolve-holder-address";
import type { PlaceLocationSource } from "../redact-place-location";
import { venueConfirmationArm } from "../../venue-confirmation";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The TRUE street, stored on an EXACT event row (freeform or public venue). */
const EXACT_EVENT: HolderAddressEventSource = {
  locationMode: "EXACT",
  locationRadiusMeters: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  addressText: "1114 Fatherland St, Nashville, TN 37206",
  locality: "Nashville",
  region: "TN",
  postalCode: "37206",
  locationLabel: "East Nashville",
  lat: 36.1773,
  lng: -86.7554,
  startsAt: new Date(NOW.getTime() + 14 * DAY),
};

const OBSCURED_EVENT: HolderAddressEventSource = {
  ...EXACT_EVENT,
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  addressRevealPreset: "DAY_BEFORE",
  addressRevealAt: new Date(NOW.getTime() + 24 * HOUR),
};

/**
 * An event at a venue that withholds its address, stored the way part 1
 * stores it: the Event row is the venue's PUBLIC projection (area label as
 * addressText, public circle centre, no postcode). None of it is the truth.
 * Its own reveal already passed (IMMEDIATELY, an hour ago) and it starts in
 * two weeks.
 */
const PROJECTION_EVENT: HolderAddressEventSource = {
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  placeId: "place-house",
  addressRevealPreset: "IMMEDIATELY",
  addressRevealAt: new Date(NOW.getTime() - HOUR),
  addressText: "East Nashville",
  locality: "Nashville",
  region: "TN",
  postalCode: null,
  locationLabel: "East Nashville",
  lat: 36.18,
  lng: -86.75,
  startsAt: new Date(NOW.getTime() + 14 * DAY),
};

const WITHHELD_PLACE: PlaceLocationSource = {
  id: "place-house",
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  locationLabel: "East Nashville",
  // Street only, like every seeded/real `Place.address`; the city travels
  // separately, exactly as on the Event row.
  formattedAddress: "901 Porter Rd",
  addressLine1: "901 Porter Rd",
  addressLine2: null,
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  lat: 36.1862,
  lng: -86.7291,
};

const PUBLIC_PLACE: PlaceLocationSource = {
  ...WITHHELD_PLACE,
  locationMode: "EXACT",
  locationRadiusMeters: null,
};

/** Everything a holder must never see while the venue's address is locked. */
function expectNoPlaceTruth(result: unknown): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain("Porter");
  expect(json).not.toContain("37206");
  expect(json).not.toContain("36.1862");
  expect(json).not.toContain("-86.7291");
}

/**
 * The gate with the defaults most cases want: an active holder, and no venue
 * arm (which only matters at a withheld venue). Each case overrides what it
 * is about.
 */
function resolve(
  overrides: Partial<ResolveHolderAddressInput> & {
    event: HolderAddressEventSource;
  },
) {
  return resolveHolderAddress({
    place: null,
    venueConfirmationArm: null,
    activeHolder: true,
    now: NOW,
    ...overrides,
  });
}

describe("resolveHolderAddress", () => {
  describe("EXACT events", () => {
    it("is unlocked and reads the Event row, unchanged", () => {
      expect(resolve({ event: EXACT_EVENT })).toEqual({
        locked: false,
        source: "EVENT",
        addressText: EXACT_EVENT.addressText,
        locality: "Nashville",
        lat: EXACT_EVENT.lat,
        lng: EXACT_EVENT.lng,
        postalCode: EXACT_EVENT.postalCode,
      });
    });

    it("still reads the Event row at a venue that publishes its address", () => {
      const result = resolve({ event: EXACT_EVENT, place: PUBLIC_PLACE });
      expect(result).toMatchObject({ locked: false, source: "EVENT" });
    });

    it("ignores a NEVER preset on an EXACT event (EXACT is never locked)", () => {
      const result = resolve({
        event: { ...EXACT_EVENT, addressRevealPreset: "NEVER" },
      });
      expect(result.locked).toBe(false);
    });

    it("is not withheld from a non-holder: an EXACT address is public anyway", () => {
      const result = resolve({ event: EXACT_EVENT, activeHolder: false });
      expect(result).toMatchObject({ locked: false, source: "EVENT" });
    });
  });

  describe("OBSCURED events", () => {
    it("before the reveal: locked, with the date and the coarse label", () => {
      expect(resolve({ event: OBSCURED_EVENT })).toEqual({
        locked: true,
        reason: "notYetRevealed",
        label: "Nashville, TN",
        revealAt: OBSCURED_EVENT.addressRevealAt,
        never: false,
      });
    });

    it("at the exact reveal instant: unlocked (now >= revealAt, like redactLocation)", () => {
      const at = OBSCURED_EVENT.addressRevealAt!;
      const result = resolve({
        event: OBSCURED_EVENT,
        now: new Date(at.getTime()),
      });
      expect(result.locked).toBe(false);
    });

    it("one millisecond before the reveal: still locked", () => {
      const at = OBSCURED_EVENT.addressRevealAt!;
      const result = resolve({
        event: OBSCURED_EVENT,
        now: new Date(at.getTime() - 1),
      });
      expect(result.locked).toBe(true);
    });

    it("after the reveal: unlocked with the Event row's true address", () => {
      const result = resolve({
        event: OBSCURED_EVENT,
        now: new Date(NOW.getTime() + 48 * HOUR),
      });
      expect(result).toEqual({
        locked: false,
        source: "EVENT",
        addressText: "1114 Fatherland St, Nashville, TN 37206",
        locality: "Nashville",
        lat: 36.1773,
        lng: -86.7554,
        postalCode: "37206",
      });
    });

    it("NEVER: locked forever, with no date, far past any date", () => {
      const result = resolve({
        event: {
          ...OBSCURED_EVENT,
          addressRevealPreset: "NEVER",
          addressRevealAt: null,
        },
        now: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(result).toEqual({
        locked: true,
        reason: "never",
        label: "Nashville, TN",
        revealAt: null,
        never: true,
      });
    });

    it("NEVER beats a stale reveal date that has already passed", () => {
      const result = resolve({
        event: {
          ...OBSCURED_EVENT,
          addressRevealPreset: "NEVER",
          addressRevealAt: new Date(NOW.getTime() - 24 * HOUR),
        },
      });
      expect(result).toMatchObject({
        locked: true,
        reason: "never",
        never: true,
        revealAt: null,
      });
    });

    it("fails closed: a null reveal date without NEVER stays locked, never=false", () => {
      const result = resolve({
        event: {
          ...OBSCURED_EVENT,
          addressRevealPreset: null,
          addressRevealAt: null,
        },
      });
      expect(result).toEqual({
        locked: true,
        reason: "notYetRevealed",
        label: "Nashville, TN",
        revealAt: null,
        never: false,
      });
    });

    it("fails closed: an invalid reveal date stays locked", () => {
      const result = resolve({
        event: { ...OBSCURED_EVENT, addressRevealAt: new Date("not a date") },
      });
      expect(result).toMatchObject({ locked: true, revealAt: null });
    });

    it.each([null, undefined, "", "exact", "HIDDEN"])(
      "fails closed: locationMode %j is treated as OBSCURED",
      (mode) => {
        const result = resolve({
          event: { ...EXACT_EVENT, locationMode: mode },
        });
        // EXACT_EVENT carries no reveal date, so OBSCURED means locked.
        expect(result.locked).toBe(true);
      },
    );
  });

  describe("an active holder only (H2)", () => {
    const REVEALED = { ...OBSCURED_EVENT, addressRevealAt: new Date(NOW.getTime() - HOUR) };

    it("an active holder after the reveal gets the street", () => {
      expect(resolve({ event: REVEALED }).locked).toBe(false);
    });

    it("a non-holder after the reveal gets only the label, and no date is promised", () => {
      // An unpaid checkout, a refunded order, a ticket transferred away.
      const result = resolve({ event: REVEALED, activeHolder: false });
      expect(result).toEqual({
        locked: true,
        reason: "notHolder",
        label: "Nashville, TN",
        revealAt: null,
        never: false,
      });
      expect(JSON.stringify(result)).not.toContain("Fatherland");
    });

    it("a non-holder before the reveal is told nothing about the date either", () => {
      const result = resolve({ event: OBSCURED_EVENT, activeHolder: false });
      expect(result).toMatchObject({ reason: "notHolder", revealAt: null });
    });

    it("fails closed: anything but literal true is not a holder", () => {
      const result = resolve({
        event: REVEALED,
        activeHolder: "yes" as unknown as boolean,
      });
      expect(result).toMatchObject({ locked: true, reason: "notHolder" });
    });
  });

  describe("the locked label", () => {
    it("prefers the coarse locality/region over the organizer's label", () => {
      const result = resolve({
        event: { ...OBSCURED_EVENT, locationLabel: "The Blue Door House" },
      });
      expect(result).toMatchObject({ locked: true, label: "Nashville, TN" });
    });

    it("falls back to the organizer's label when there is no locality/region", () => {
      const result = resolve({
        event: { ...OBSCURED_EVENT, locality: null, region: null },
      });
      expect(result).toMatchObject({ locked: true, label: "East Nashville" });
    });

    it("is null, never the street, when there is nothing coarse", () => {
      const result = resolve({
        event: {
          ...OBSCURED_EVENT,
          locality: null,
          region: null,
          locationLabel: "   ",
        },
      });
      expect(result).toMatchObject({ locked: true, label: null });
    });

    it("never uses the venue's name or the venue's own label", () => {
      const result = resolve({
        event: { ...OBSCURED_EVENT, locality: null, region: null, locationLabel: null },
        place: { ...WITHHELD_PLACE, locationLabel: "SoMa" },
        venueConfirmationArm: "owner",
      });
      expect(result).toMatchObject({ locked: true, label: null });
      expect(JSON.stringify(result)).not.toContain("Porter");
      expect(JSON.stringify(result)).not.toContain("SoMa");
    });
  });

  describe("a venue that withholds its address: WHO it releases it to (C1)", () => {
    it("C1: an UNCONFIRMED third-party event with IMMEDIATELY reveal and a real ticket stays locked", () => {
      // The exploit: attach a free event to somebody's withheld house, pick
      // IMMEDIATELY, publish, claim a ticket. The event's own schedule has
      // passed and the viewer is a genuine holder — and still gets nothing.
      const result = resolve({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: null,
        activeHolder: true,
      });
      expect(result).toEqual({
        locked: true,
        reason: "venueUnconfirmed",
        label: "Nashville, TN",
        revealAt: null,
        never: false,
      });
      expectNoPlaceTruth(result);
    });

    it("C1: stays locked forever, however late it gets", () => {
      const result = resolve({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: null,
        now: new Date("2099-01-01T00:00:00.000Z"),
      });
      expect(result).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
      expectNoPlaceTruth(result);
    });

    it("C1: a WITHDRAWN stamp releases nothing (the arm derivation says unconfirmed)", () => {
      const withdrawn = {
        orgId: "org-third-party",
        humanId: null,
        placeId: "place-house",
        stewardship: "OWNED" as const,
        venueConfirmedAt: new Date(NOW.getTime() - 5 * DAY),
        venueConfirmationWithdrawnAt: new Date(NOW.getTime() - DAY),
        venueConfirmedPlaceId: "place-house",
      };
      const arm = venueConfirmationArm(withdrawn, {
        id: "place-house",
        orgIdsWithAccess: ["org-house"],
        humanIdsWithAccess: [],
        acceptsCommunityListings: false,
      });
      expect(arm).toBeNull();
      const result = resolve({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: arm,
      });
      expect(result).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
      expectNoPlaceTruth(result);
    });

    it("the COMMUNITY arm (blanket consent to listings) never unlocks", () => {
      // An ownerless listing at a house that accepts community listings is
      // the same exploit: anyone could have written it.
      for (const now of [NOW, new Date(PROJECTION_EVENT.startsAt!.getTime() - HOUR), new Date("2099-01-01T00:00:00.000Z")]) {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "community",
          now,
        });
        expect(result).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
        expectNoPlaceTruth(result);
      }
    });

    it("fails closed: an unrecognised arm is unconfirmed", () => {
      const result = resolve({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: "admin" as unknown as null,
      });
      expect(result).toMatchObject({ locked: true, reason: "venueUnconfirmed" });
    });

    describe("OWNER arm: the venue's own show keeps its own schedule", () => {
      it("after the event's reveal: the TRUE address comes from the Place, not the Event projection", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
        });
        expect(result).toEqual({
          locked: false,
          source: "PLACE",
          addressText: "901 Porter Rd",
          locality: "Nashville",
          lat: 36.1862,
          lng: -86.7291,
          postalCode: "37206",
        });
        // The projection is what a public viewer sees; it must not be served
        // to a holder as if it were the address.
        expect(result).not.toMatchObject({ addressText: PROJECTION_EVENT.addressText });
        expect(result).not.toMatchObject({ lat: PROJECTION_EVENT.lat });
      });

      it("before the event's reveal: locked until the event's own date, and nothing from the Place leaks", () => {
        const revealAt = new Date(NOW.getTime() + HOUR);
        const result = resolve({
          event: { ...PROJECTION_EVENT, addressRevealAt: revealAt },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
        });
        expect(result).toMatchObject({
          locked: true,
          reason: "notYetRevealed",
          revealAt,
          never: false,
        });
        expectNoPlaceTruth(result);
      });

      it("a non-holder at the venue's own show gets nothing", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
          activeHolder: false,
        });
        expect(result).toMatchObject({ locked: true, reason: "notHolder" });
        expectNoPlaceTruth(result);
      });

      it("NEVER at the venue's own show: locked forever", () => {
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            addressRevealPreset: "NEVER",
            addressRevealAt: null,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
          now: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(result).toMatchObject({ locked: true, reason: "never", never: true });
      });

      it("floors an EXACT event row to OBSCURED: locked (it has no reveal date)", () => {
        // Published EXACT before the venue was hidden.
        const result = resolve({
          event: EXACT_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
        });
        expect(result).toEqual({
          locked: true,
          reason: "notYetRevealed",
          label: "Nashville, TN",
          revealAt: null,
          never: false,
        });
      });

      it("falls back to the Place's street lines when it has no formatted address", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: {
            ...WITHHELD_PLACE,
            formattedAddress: null,
            addressLine2: "Back house",
          },
          venueConfirmationArm: "owner",
        });
        expect(result).toMatchObject({
          locked: false,
          source: "PLACE",
          addressText: "901 Porter Rd, Back house",
          locality: "Nashville",
        });
      });
    });

    describe("STAMP arm: a confirmed third party, not before a day ahead", () => {
      const floor = new Date(
        PROJECTION_EVENT.startsAt!.getTime() - STAMP_ARM_REVEAL_LEAD_MS,
      );

      it("IMMEDIATELY reveal: locked until startsAt − 24h, with that date", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
        });
        expect(result).toEqual({
          locked: true,
          reason: "notYetRevealed",
          label: "Nashville, TN",
          revealAt: floor,
          never: false,
        });
        expectNoPlaceTruth(result);
      });

      it("one millisecond before startsAt − 24h: still locked", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date(floor.getTime() - 1),
        });
        expect(result.locked).toBe(true);
        expectNoPlaceTruth(result);
      });

      it("at startsAt − 24h: the Place's truth", () => {
        const result = resolve({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: floor,
        });
        expect(result).toEqual({
          locked: false,
          source: "PLACE",
          addressText: "901 Porter Rd",
          locality: "Nashville",
          lat: 36.1862,
          lng: -86.7291,
          postalCode: "37206",
        });
      });

      it("an event reveal LATER than the floor wins (the later of the two)", () => {
        const oneHourBefore = new Date(
          PROJECTION_EVENT.startsAt!.getTime() - HOUR,
        );
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            addressRevealPreset: "ONE_HOUR_BEFORE",
            addressRevealAt: oneHourBefore,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date(floor.getTime() + HOUR),
        });
        expect(result).toMatchObject({
          locked: true,
          reason: "notYetRevealed",
          revealAt: oneHourBefore,
        });
      });

      it("NEVER stays NEVER", () => {
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            addressRevealPreset: "NEVER",
            addressRevealAt: null,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(result).toMatchObject({ locked: true, reason: "never" });
        expectNoPlaceTruth(result);
      });

      it("fails closed without a usable start: locked, no date", () => {
        const result = resolve({
          event: { ...PROJECTION_EVENT, startsAt: null },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date("2099-01-01T00:00:00.000Z"),
        });
        expect(result).toMatchObject({
          locked: true,
          reason: "notYetRevealed",
          revealAt: null,
        });
        expectNoPlaceTruth(result);
      });
    });

    describe("STAMP arm floor is anchored on the start the venue CONFIRMED (N1)", () => {
      // The venue confirmed a show three months out. The third party then
      // moved it to tomorrow (to collect the reveal) — the floor must stay a
      // day before the CONFIRMED date, not a day before the edited one.
      const confirmedStartsAt = new Date(NOW.getTime() + 90 * DAY);
      const movedStartsAt = new Date(NOW.getTime() + 1 * DAY);
      const confirmedFloor = new Date(
        confirmedStartsAt.getTime() - STAMP_ARM_REVEAL_LEAD_MS,
      );

      it("N1 attack: moving a confirmed show EARLIER does not pull the reveal forward", () => {
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            startsAt: movedStartsAt,
            venueConfirmedStartsAt: confirmedStartsAt,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          // Past the day-before of the MOVED date, and even past the moved
          // show itself — still locked.
          now: new Date(movedStartsAt.getTime() + HOUR),
        });
        expect(result).toEqual({
          locked: true,
          reason: "notYetRevealed",
          label: "Nashville, TN",
          revealAt: confirmedFloor,
          never: false,
        });
        expectNoPlaceTruth(result);
      });

      it("one millisecond before the confirmed floor: still locked; AT it: the Place's truth", () => {
        const event = {
          ...PROJECTION_EVENT,
          startsAt: movedStartsAt,
          venueConfirmedStartsAt: confirmedStartsAt,
        };
        const before = resolve({
          event,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date(confirmedFloor.getTime() - 1),
        });
        expect(before.locked).toBe(true);
        expectNoPlaceTruth(before);
        const at = resolve({
          event,
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: confirmedFloor,
        });
        expect(at).toMatchObject({ locked: false, source: "PLACE" });
      });

      it("moving the show LATER still defers the reveal (the later start wins)", () => {
        const laterStartsAt = new Date(NOW.getTime() + 120 * DAY);
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            startsAt: laterStartsAt,
            venueConfirmedStartsAt: confirmedStartsAt,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
          now: new Date(confirmedFloor.getTime() + HOUR),
        });
        expect(result).toMatchObject({
          locked: true,
          reason: "notYetRevealed",
          revealAt: new Date(laterStartsAt.getTime() - STAMP_ARM_REVEAL_LEAD_MS),
        });
      });

      it("no recorded confirmed start (null / absent / invalid): the live start alone", () => {
        const liveFloor = new Date(
          PROJECTION_EVENT.startsAt!.getTime() - STAMP_ARM_REVEAL_LEAD_MS,
        );
        for (const venueConfirmedStartsAt of [
          null,
          undefined,
          new Date(Number.NaN),
        ]) {
          const result = resolve({
            event: { ...PROJECTION_EVENT, venueConfirmedStartsAt },
            place: WITHHELD_PLACE,
            venueConfirmationArm: "stamp",
          });
          expect(result).toMatchObject({ locked: true, revealAt: liveFloor });
        }
      });

      it("a confirmed start EARLIER than the live one never lowers the floor", () => {
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            venueConfirmedStartsAt: new Date(NOW.getTime() - 30 * DAY),
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "stamp",
        });
        expect(result).toMatchObject({
          locked: true,
          revealAt: new Date(
            PROJECTION_EVENT.startsAt!.getTime() - STAMP_ARM_REVEAL_LEAD_MS,
          ),
        });
      });

      it("the OWNER arm ignores it (the venue's own show keeps its own schedule)", () => {
        const result = resolve({
          event: {
            ...PROJECTION_EVENT,
            startsAt: movedStartsAt,
            venueConfirmedStartsAt: confirmedStartsAt,
          },
          place: WITHHELD_PLACE,
          venueConfirmationArm: "owner",
        });
        expect(result).toMatchObject({ locked: false, source: "PLACE" });
      });
    });

    it("a venue that PUBLISHES its address needs no vouch: the event's own schedule", () => {
      const result = resolve({
        event: { ...PROJECTION_EVENT, addressText: "901 Porter Rd" },
        place: PUBLIC_PLACE,
        venueConfirmationArm: null,
      });
      expect(result).toMatchObject({
        locked: false,
        source: "EVENT",
        addressText: "901 Porter Rd",
      });
    });

    it("an event with no venue link and no place reads the Event row", () => {
      const result = resolve({
        event: { ...PROJECTION_EVENT, placeId: null },
      });
      expect(result).toMatchObject({ locked: false, source: "EVENT" });
    });

    it("fails closed when the linked venue does not resolve: an EXACT row is locked", () => {
      // `Event.placeId` is onDelete SetNull, so this is a read race — but the
      // event row must not speak for a venue that may withhold its address.
      const result = resolve({
        event: { ...EXACT_EVENT, placeId: "place-gone" },
        place: null,
      });
      expect(result).toMatchObject({ locked: true, never: false, revealAt: null });
      expect(JSON.stringify(result)).not.toContain("Fatherland");
    });

    it("fails closed when the linked venue does not resolve: locked as placeUnavailable, not venueUnconfirmed", () => {
      // Callers derive the arm from the same row; a row that did not load
      // has no arm. The reason is NOT "the venue has not confirmed" — nobody
      // could read the venue — so a surface does not blame the venue.
      const result = resolve({
        event: { ...PROJECTION_EVENT, placeId: "place-gone" },
        place: undefined,
        venueConfirmationArm: venueConfirmationArm(
          {
            orgId: "org-house",
            humanId: null,
            placeId: "place-gone",
            stewardship: "OWNED",
          },
          null,
        ),
      });
      expect(result).toMatchObject({
        locked: true,
        reason: "placeUnavailable",
        revealAt: null,
        never: false,
      });
      expectNoPlaceTruth(result);
    });

    it("an unresolved venue with an arm anyway is still locked (placeUnavailable)", () => {
      const result = resolve({
        event: { ...PROJECTION_EVENT, placeId: "place-gone" },
        place: undefined,
        venueConfirmationArm: "owner",
      });
      expect(result).toMatchObject({
        locked: true,
        reason: "placeUnavailable",
        label: "Nashville, TN",
        revealAt: null,
      });
    });

    it("NEVER still wins over an unreadable venue (the organizer's choice is the reason)", () => {
      const result = resolve({
        event: {
          ...PROJECTION_EVENT,
          placeId: "place-gone",
          addressRevealPreset: "NEVER",
          addressRevealAt: null,
        },
        place: null,
        venueConfirmationArm: null,
      });
      expect(result).toMatchObject({ locked: true, reason: "never" });
    });

    it("a freeform event (no venue link) is never placeUnavailable", () => {
      const result = resolve({
        event: { ...OBSCURED_EVENT, placeId: null },
        place: null,
      });
      expect(result).toMatchObject({ locked: true, reason: "notYetRevealed" });
    });
  });
});

describe("holderRevealSchedule", () => {
  it("placeUnavailable for a venue link that did not resolve", () => {
    expect(
      holderRevealSchedule({
        event: { ...PROJECTION_EVENT, placeId: "place-gone" },
        place: null,
        venueConfirmationArm: null,
      }),
    ).toEqual({ kind: "placeUnavailable" });
  });

  it("the stamp arm's date is anchored on the LATER of the live and confirmed starts (N1)", () => {
    const confirmedStartsAt = new Date(NOW.getTime() + 60 * DAY);
    expect(
      holderRevealSchedule({
        event: {
          ...PROJECTION_EVENT,
          startsAt: new Date(NOW.getTime() + 2 * DAY),
          venueConfirmedStartsAt: confirmedStartsAt,
        },
        place: WITHHELD_PLACE,
        venueConfirmationArm: "stamp",
      }),
    ).toEqual({
      kind: "scheduled",
      revealAt: new Date(confirmedStartsAt.getTime() - STAMP_ARM_REVEAL_LEAD_MS),
    });
  });

  it("open for an effective-EXACT event", () => {
    expect(
      holderRevealSchedule({ event: EXACT_EVENT, place: null, venueConfirmationArm: null }),
    ).toEqual({ kind: "open" });
  });

  it("never for NEVER", () => {
    expect(
      holderRevealSchedule({
        event: { ...OBSCURED_EVENT, addressRevealPreset: "NEVER", addressRevealAt: null },
        place: null,
        venueConfirmationArm: null,
      }),
    ).toEqual({ kind: "never" });
  });

  it("venueUnconfirmed for an unconfirmed or community event at a withheld venue", () => {
    for (const arm of [null, undefined, "community" as const]) {
      expect(
        holderRevealSchedule({
          event: PROJECTION_EVENT,
          place: WITHHELD_PLACE,
          venueConfirmationArm: arm,
        }),
      ).toEqual({ kind: "venueUnconfirmed" });
    }
  });

  it("the stamp arm's effective date is the later of the event's and startsAt − 24h", () => {
    expect(
      holderRevealSchedule({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: "stamp",
      }),
    ).toEqual({
      kind: "scheduled",
      revealAt: new Date(PROJECTION_EVENT.startsAt!.getTime() - DAY),
    });
  });

  it("the owner arm keeps the event's own date", () => {
    expect(
      holderRevealSchedule({
        event: PROJECTION_EVENT,
        place: WITHHELD_PLACE,
        venueConfirmationArm: "owner",
      }),
    ).toEqual({ kind: "scheduled", revealAt: PROJECTION_EVENT.addressRevealAt });
  });
});

describe("holderAddressLine", () => {
  it("is the label while locked, the street once unlocked, null when unresolved", () => {
    expect(holderAddressLine(resolve({ event: OBSCURED_EVENT }))).toBe(
      "Nashville, TN",
    );
    expect(holderAddressLine(resolve({ event: EXACT_EVENT }))).toBe(
      "1114 Fatherland St, Nashville, TN 37206",
    );
    expect(holderAddressLine(undefined)).toBeNull();
    expect(holderAddressLine(null)).toBeNull();
  });
});
