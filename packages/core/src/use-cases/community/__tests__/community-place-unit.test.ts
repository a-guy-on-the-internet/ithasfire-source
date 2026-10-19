import { describe, expect, it } from "vitest";

import { createCommunityPlace } from "../create-community-place";
import { updateCommunityPlace } from "../update-community-place";
import { PLACE_UNIT_MAX_LENGTH } from "../../../lib/location/place-unit";
import { communityWriteAddress } from "../_shared/community-place-unit";
import {
  ADDRESS,
  EXISTING_PLACE_ID,
  NEW_PLACE_ID,
  auditRows,
  buildHarness,
  makePlace,
} from "./community-place-harness";
import { MODERATOR_ID } from "./helpers";

/**
 * "Unit or room" on a community place: stored in `addrLine2` and folded into
 * the formatted text by the server, so the unit shows once on every surface
 * (public ones read the formatted text; staff panels read the street lines).
 */

const STREET = "2190 Nolensville Pike";
const BARE = `${STREET}, Nashville, TN 37211, USA`;
const WITH_UNIT_A = `${STREET}, Unit A, Nashville, TN 37211, USA`;

// The fold/strip rules themselves: lib/location/__tests__/place-unit.test.ts.
describe("communityWriteAddress", () => {
  it("carries the unit as line2 and drops a null one", () => {
    const address = { ...ADDRESS, formatted: BARE, line1: STREET };
    expect(communityWriteAddress(address, "Unit A")).toMatchObject({
      formatted: WITH_UNIT_A,
      line1: STREET,
      line2: "Unit A",
    });
    const none = communityWriteAddress({ ...address, line2: null }, null);
    expect(none).not.toHaveProperty("line2");
    expect(none.formatted).toBe(BARE);
  });
});

describe("createCommunityPlace — unit", () => {
  const INPUT = {
    actorHumanId: MODERATOR_ID,
    name: "Corner Bar South",
    address: { ...ADDRESS, formatted: BARE, line1: STREET },
    clientKey: "community-place-unit-create",
  };

  it("stores the unit in addrLine2 and once in the formatted text", async () => {
    const h = buildHarness();

    const result = await createCommunityPlace(h.deps, {
      ...INPUT,
      address: { ...INPUT.address, line2: "  Unit A " },
    });

    expect(result.formattedAddress).toBe(WITH_UNIT_A);
    expect(h.rows.get(NEW_PLACE_ID)).toMatchObject({
      formattedAddress: WITH_UNIT_A,
      addressLine1: STREET,
      addressLine2: "Unit A",
    });
    const created = auditRows(h.mocks.auditRepo.log).find((r) => r.action === "place.community_created");
    expect(created?.data).toMatchObject({
      formattedAddress: WITH_UNIT_A,
      addressLine2: "Unit A",
    });
  });

  it("without a unit (absent, null or blank) leaves addrLine2 NULL", async () => {
    for (const line2 of [undefined, null, "   "]) {
      const h = buildHarness();
      await createCommunityPlace(h.deps, {
        ...INPUT,
        address: {
          ...INPUT.address,
          ...(line2 === undefined ? {} : { line2 }),
        },
      });
      expect(h.rows.get(NEW_PLACE_ID)).toMatchObject({
        formattedAddress: BARE,
        addressLine2: null,
      });
    }
  });

  it(`refuses a unit over PLACE_UNIT_MAX_LENGTH (${PLACE_UNIT_MAX_LENGTH}) characters`, async () => {
    const h = buildHarness();
    await expect(
      createCommunityPlace(h.deps, {
        ...INPUT,
        address: {
          ...INPUT.address,
          line2: "x".repeat(PLACE_UNIT_MAX_LENGTH + 1),
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });
});

describe("updateCommunityPlace — unit", () => {
  // A community place made with "Unit A": folded text + addrLine2.
  const STORED = makePlace({
    name: "Corner Bar South",
    formattedAddress: WITH_UNIT_A,
    addressHash: WITH_UNIT_A.toLowerCase(),
    addressLine1: STREET,
    addressLine2: "Unit A",
    city: "Nashville",
    region: "TN",
    postalCode: "37211",
    countryCode: "US",
    timezone: "America/Chicago",
    admissionTaxRateBps: 975,
    taxRateSource: "ziptax",
  });

  const NAME_ONLY = {
    actorHumanId: MODERATOR_ID,
    placeId: EXISTING_PLACE_ID,
    name: "Corner Bar South",
    clientKey: "community-place-unit-edit",
  };

  // A fresh pick of the same building: the geocoder's text has no unit.
  const PICKED = {
    formatted: BARE,
    line1: STREET,
    city: "Nashville",
    region: "TN",
    postalCode: "37211",
    countryCode: "US",
    lat: STORED.lat!,
    lng: STORED.lng!,
  };

  it("a name-only edit keeps the unit and the text exactly", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, { ...NAME_ONLY, name: "Corner Bar S." });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      name: "Corner Bar S.",
      formattedAddress: WITH_UNIT_A,
      addressLine2: "Unit A",
    });
  });

  it("a unit-only edit (no address) swaps the unit in the text and keeps every other column", async () => {
    const h = buildHarness({ places: [STORED] });

    const result = await updateCommunityPlace(h.deps, {
      ...NAME_ONLY,
      line2: "Back room",
    });

    expect(result.formattedAddress).toBe(
      `${STREET}, Back room, Nashville, TN 37211, USA`,
    );
    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      addressLine1: STREET,
      addressLine2: "Back room",
      postalCode: "37211",
      countryCode: "US",
      admissionTaxRateBps: 975,
      lat: STORED.lat,
      lng: STORED.lng,
    });
    expect(h.mocks.taxRateLookup.lookupByPostalCode).not.toHaveBeenCalled();
    const updated = auditRows(h.mocks.auditRepo.log).find((r) => r.action === "place.community_updated");
    expect(updated?.data).toMatchObject({
      from: { addressLine2: "Unit A", formattedAddress: WITH_UNIT_A },
      to: { addressLine2: "Back room" },
    });
  });

  it("a unit-only edit with null clears the unit from the column and the text", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, { ...NAME_ONLY, line2: null });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      formattedAddress: BARE,
      addressLine2: null,
    });
  });

  it("a present address WITHOUT line2 keeps the stored unit (folded into the new text)", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, { ...NAME_ONLY, address: PICKED });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      formattedAddress: WITH_UNIT_A,
      addressLine2: "Unit A",
    });
  });

  it("a present address with line2 null or \"\" clears the unit", async () => {
    for (const line2 of [null, ""]) {
      const h = buildHarness({ places: [STORED] });
      await updateCommunityPlace(h.deps, {
        ...NAME_ONLY,
        address: { ...PICKED, line2 },
      });
      expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
        formattedAddress: BARE,
        addressLine2: null,
      });
    }
  });

  it("a present address with a new line2 sets it", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, {
      ...NAME_ONLY,
      address: { ...PICKED, line2: "Suite 2" },
    });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      formattedAddress: `${STREET}, Suite 2, Nashville, TN 37211, USA`,
      addressLine2: "Suite 2",
    });
  });

  it("refuses the unit sent both in the address and on its own, before any claim", async () => {
    const h = buildHarness({ places: [STORED] });

    await expect(
      updateCommunityPlace(h.deps, {
        ...NAME_ONLY,
        address: { ...PICKED, line2: "Suite 2" },
        line2: "Suite 2",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "UNIT_SENT_TWICE" },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("a clientKey used for a unit change conflicts when replayed with a different unit", async () => {
    const h = buildHarness({ places: [STORED] });

    await updateCommunityPlace(h.deps, { ...NAME_ONLY, line2: "Back room" });

    await expect(
      updateCommunityPlace(h.deps, { ...NAME_ONLY, line2: "Unit B" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    await expect(
      updateCommunityPlace(h.deps, NAME_ONLY),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("a legacy place (unit folded into line1 by the old client, addrLine2 NULL) keeps its text on a unit-less edit", async () => {
    const legacy = makePlace({
      ...STORED,
      addressLine1: `${STREET}, Unit A`,
      addressLine2: null,
    });
    const h = buildHarness({ places: [legacy] });

    await updateCommunityPlace(h.deps, { ...NAME_ONLY, line2: null });

    expect(h.rows.get(EXISTING_PLACE_ID)).toMatchObject({
      formattedAddress: WITH_UNIT_A,
      addressLine1: `${STREET}, Unit A`,
      addressLine2: null,
    });
  });

  /** Create, then save it again `n` times the way the dialog does. */
  async function createThenResave(unit: string, resaves: Array<string | null>) {
    const h = buildHarness();
    await createCommunityPlace(h.deps, {
      actorHumanId: MODERATOR_ID,
      name: "Corner Bar South",
      address: { ...PICKED, line2: unit },
      clientKey: "community-place-unit-create-2",
    });
    const texts: string[] = [h.rows.get(NEW_PLACE_ID)!.formattedAddress!];
    for (const [i, next] of resaves.entries()) {
      await updateCommunityPlace(h.deps, {
        ...NAME_ONLY,
        placeId: NEW_PLACE_ID,
        line2: next,
        clientKey: `community-place-unit-resave-${i}`,
      });
      texts.push(h.rows.get(NEW_PLACE_ID)!.formattedAddress!);
    }
    return { h, texts };
  }

  it("a unit with a comma survives two dialog re-saves byte for byte", async () => {
    const unit = "Unit A, Floor 2";
    const { h, texts } = await createThenResave(unit, [unit, unit]);

    const expected = `${STREET}, Unit A, Floor 2, Nashville, TN 37211, USA`;
    expect(texts).toEqual([expected, expected, expected]);
    expect(h.rows.get(NEW_PLACE_ID)).toMatchObject({
      addressLine2: unit,
      addressHash: expected.toLowerCase(),
    });
  });

  it("a comma unit changed to another comma unit replaces it in place", async () => {
    const { texts } = await createThenResave("Unit A, Floor 2", [
      "Suite 9, Rear",
    ]);
    expect(texts[1]).toBe(`${STREET}, Suite 9, Rear, Nashville, TN 37211, USA`);
  });

  it("a unit equal to the city, then changed or cleared: the city stays", async () => {
    const { texts } = await createThenResave("Nashville", ["Back room", null]);
    expect(texts).toEqual([
      `${STREET}, Nashville, Nashville, TN 37211, USA`,
      `${STREET}, Back room, Nashville, TN 37211, USA`,
      BARE,
    ]);
  });
});
