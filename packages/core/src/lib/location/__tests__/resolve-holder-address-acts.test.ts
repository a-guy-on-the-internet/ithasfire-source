import { describe, expect, it } from "vitest";

import {
  resolveHolderAddress,
  STAMP_ARM_REVEAL_LEAD_MS,
  type HolderAddressEventSource,
  type ResolveHolderAddressInput,
} from "../resolve-holder-address";
import type { PlaceLocationSource } from "../redact-place-location";
import { isActOnBill } from "../../event-human-roles";

/**
 * ACTS ON THE BILL (arrival-areas FR-009, owner ruling 2026-10-16).
 *
 * An act skips the EVENT's own reveal schedule and nothing else: every gate
 * that protects a withheld PLACE binds acts exactly as it binds holders,
 * because an organiser can list anyone (themselves included) as a performer.
 */

const NOW = new Date("2026-10-16T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const WITHHELD_PLACE: PlaceLocationSource = {
  id: "place-house",
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  locationLabel: "East Nashville",
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

/**
 * An event at the withheld house, its own reveal a WEEK away (DAY_BEFORE a
 * show in eight days), starting in eight days.
 */
const AT_HOUSE: HolderAddressEventSource = {
  locationMode: "OBSCURED",
  locationRadiusMeters: 800,
  placeId: "place-house",
  addressRevealPreset: "DAY_BEFORE",
  addressRevealAt: new Date(NOW.getTime() + 7 * DAY),
  addressText: "East Nashville",
  locality: "Nashville",
  region: "TN",
  postalCode: null,
  locationLabel: "East Nashville",
  lat: 36.18,
  lng: -86.75,
  startsAt: new Date(NOW.getTime() + 8 * DAY),
};

/** A freeform OBSCURED event: the organiser's own address. */
const FREEFORM: HolderAddressEventSource = {
  locationMode: "OBSCURED",
  locationRadiusMeters: 500,
  placeId: null,
  addressRevealPreset: "DAY_BEFORE",
  addressRevealAt: new Date(NOW.getTime() + 7 * DAY),
  addressText: "1114 Fatherland St",
  locality: "Nashville",
  region: "TN",
  postalCode: "37206",
  locationLabel: "East Nashville",
  lat: 36.1773,
  lng: -86.7554,
  startsAt: new Date(NOW.getTime() + 8 * DAY),
};

function act(
  overrides: Partial<ResolveHolderAddressInput> & { event: HolderAddressEventSource },
) {
  return resolveHolderAddress({
    place: WITHHELD_PLACE,
    venueConfirmationArm: "owner",
    activeHolder: false,
    actOnBill: true,
    now: NOW,
    ...overrides,
  });
}

function expectNoPlaceTruth(result: unknown): void {
  const json = JSON.stringify(result);
  expect(json).not.toContain("Porter");
  expect(json).not.toContain("37206");
  expect(json).not.toContain("36.1862");
  expect(json).not.toContain("-86.7291");
}

describe("resolveHolderAddress — acts on the bill", () => {
  it("owner arm: an act gets the place's address before the event's reveal date", () => {
    expect(act({ event: AT_HOUSE })).toEqual({
      locked: false,
      source: "PLACE",
      addressText: "901 Porter Rd",
      locality: "Nashville",
      lat: 36.1862,
      lng: -86.7291,
      postalCode: "37206",
    });
  });

  it("the same viewer as a mere holder is still waiting for the reveal (control)", () => {
    const result = act({ event: AT_HOUSE, activeHolder: true, actOnBill: false });
    expect(result).toMatchObject({
      locked: true,
      reason: "notYetRevealed",
      revealAt: AT_HOUSE.addressRevealAt,
    });
    expectNoPlaceTruth(result);
  });

  it("a freeform event: the act gets the event's address on listing", () => {
    expect(act({ event: FREEFORM, place: null, venueConfirmationArm: null })).toMatchObject({
      locked: false,
      source: "EVENT",
      addressText: "1114 Fatherland St",
    });
  });

  it("C1: a withheld place that did not vouch (community / no arm) locks acts for good", () => {
    for (const venueConfirmationArm of ["community", null, undefined, "bogus"] as const) {
      const result = act({
        event: AT_HOUSE,
        venueConfirmationArm: venueConfirmationArm as never,
      });
      expect(result).toMatchObject({ locked: true, reason: "venueUnconfirmed", revealAt: null });
      expectNoPlaceTruth(result);
    }
  });

  it("an unreadable place locks acts (placeUnavailable)", () => {
    const result = act({ event: AT_HOUSE, place: null });
    expect(result).toMatchObject({ locked: true, reason: "placeUnavailable" });
    expectNoPlaceTruth(result);
  });

  it("NEVER locks acts too (fail closed, pending the owner)", () => {
    const result = act({
      event: { ...AT_HOUSE, addressRevealPreset: "NEVER", addressRevealAt: null },
    });
    expect(result).toMatchObject({ locked: true, reason: "never", never: true });
    expectNoPlaceTruth(result);
    // Freeform NEVER as well.
    expect(
      act({
        event: { ...FREEFORM, addressRevealPreset: "NEVER" },
        place: null,
        venueConfirmationArm: null,
      }),
    ).toMatchObject({ locked: true, reason: "never" });
  });

  describe("stamp arm: the 24h place floor binds acts (N1)", () => {
    const floor = AT_HOUSE.startsAt!.getTime() - STAMP_ARM_REVEAL_LEAD_MS;

    it("earlier than a day before the show: locked, promising the floor", () => {
      const result = act({ event: AT_HOUSE, venueConfirmationArm: "stamp" });
      expect(result).toMatchObject({
        locked: true,
        reason: "notYetRevealed",
        revealAt: new Date(floor),
      });
      expectNoPlaceTruth(result);
    });

    it("at the floor: released, even with the event's own reveal still ahead", () => {
      const result = act({
        event: { ...AT_HOUSE, addressRevealAt: new Date(AT_HOUSE.startsAt!.getTime() + HOUR) },
        venueConfirmationArm: "stamp",
        now: new Date(floor),
      });
      expect(result).toMatchObject({ locked: false, source: "PLACE" });
    });

    it("the CONFIRMED start raises the floor: moving the show earlier does not help", () => {
      const result = act({
        event: {
          ...AT_HOUSE,
          startsAt: new Date(NOW.getTime() + HOUR),
          venueConfirmedStartsAt: new Date(NOW.getTime() + 30 * DAY),
        },
        venueConfirmationArm: "stamp",
      });
      expect(result).toMatchObject({ locked: true, reason: "notYetRevealed" });
      expectNoPlaceTruth(result);
    });

    it("no usable start: stays locked", () => {
      const result = act({
        event: { ...AT_HOUSE, startsAt: null },
        venueConfirmationArm: "stamp",
        now: new Date(NOW.getTime() + 365 * DAY),
      });
      expect(result).toMatchObject({ locked: true, reason: "notYetRevealed", revealAt: null });
    });
  });

  it("an EXACT event is open to everyone whatever actOnBill says", () => {
    expect(
      act({ event: { ...FREEFORM, locationMode: "EXACT" }, place: null, actOnBill: false }),
    ).toMatchObject({ locked: false });
  });

  it("only literal true counts as an act", () => {
    const result = act({ event: AT_HOUSE, actOnBill: "yes" as unknown as boolean });
    expect(result).toMatchObject({ locked: true, reason: "notHolder" });
  });

  it("holder AND act: the act's earlier release wins", () => {
    expect(act({ event: AT_HOUSE, activeHolder: true })).toMatchObject({ locked: false });
  });

  it("holder AND act, both waiting: the earliest promised date is reported", () => {
    const result = act({
      event: AT_HOUSE,
      activeHolder: true,
      venueConfirmationArm: "stamp",
    });
    // Holder: max(event reveal, floor) = event reveal (a day before the show =
    // the floor here); act: the floor. Both the floor.
    expect(result).toMatchObject({
      locked: true,
      reason: "notYetRevealed",
      revealAt: new Date(AT_HOUSE.startsAt!.getTime() - STAMP_ARM_REVEAL_LEAD_MS),
    });
  });
});

describe("isActOnBill", () => {
  const VIEWER = "11111111-1111-4111-8111-111111111111";

  it("counts PERFORMER, HOST, DJ, INSTRUCTOR and SPEAKER rows linked to the viewer", () => {
    for (const role of ["PERFORMER", "HOST", "DJ", "INSTRUCTOR", "SPEAKER"]) {
      expect(isActOnBill([{ humanId: VIEWER, orgId: null, role }], VIEWER)).toBe(true);
    }
  });

  it("does not count VENDOR, VOLUNTEER or OTHER", () => {
    for (const role of ["VENDOR", "VOLUNTEER", "OTHER"]) {
      expect(isActOnBill([{ humanId: VIEWER, orgId: null, role }], VIEWER)).toBe(false);
    }
  });

  it("does not count group rows, free-text rows, someone else's row, or no viewer", () => {
    expect(isActOnBill([{ humanId: null, orgId: "org-1", role: "PERFORMER" }], VIEWER)).toBe(false);
    expect(
      isActOnBill([{ humanId: null, orgId: null, role: "PERFORMER", externalName: VIEWER } as never], VIEWER),
    ).toBe(false);
    expect(isActOnBill([{ humanId: "someone-else", orgId: null, role: "PERFORMER" }], VIEWER)).toBe(false);
    expect(isActOnBill([{ humanId: VIEWER, orgId: null, role: "PERFORMER" }], undefined)).toBe(false);
    expect(isActOnBill([{ humanId: "", orgId: null, role: "PERFORMER" }], "")).toBe(false);
  });
});
