import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { createCommunityPlace } from "../create-community-place";
import {
  DUPLICATE_RADIUS_METERS,
  normalizePlaceName,
} from "../_shared/community-place";
import { resolveListingPlaceLocation } from "../_shared/resolve-listing-place";
import {
  ADDRESS,
  EXISTING_PLACE_ID,
  NEW_PLACE_ID,
  OTHER_PLACE_ID,
  PIN,
  auditRows,
  buildHarness,
  makePlace,
} from "./community-place-harness";
import { ADMIN_ID, MODERATOR_ID, USER_ID } from "./helpers";

/**
 * createCommunityPlace — a community moderator adds a place nobody owns, so a
 * listing can be held at a room no geocoder knows by name (owner ruling
 * 2026-10-13). The write goes through upsertPlace's `writePlaceInTx`.
 */

const BASE_INPUT = {
  actorHumanId: MODERATOR_ID,
  name: "Corner Bar South",
  address: ADDRESS,
  clientKey: "community-place-key-1",
};

describe("createCommunityPlace — who may", () => {
  it("refuses a signed-in human who is not a moderator, before any write", async () => {
    const h = buildHarness();

    await expect(
      createCommunityPlace(h.deps, { ...BASE_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("asks the port for COMMUNITY_MODERATOR or ADMIN", async () => {
    const h = buildHarness();

    await createCommunityPlace(h.deps, BASE_INPUT);

    expect(h.deps.authz.hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: MODERATOR_ID,
        requiredRoles: ["COMMUNITY_MODERATOR", "ADMIN"],
      }),
    );
  });

  it("lets a platform ADMIN create one", async () => {
    const h = buildHarness();

    const result = await createCommunityPlace(h.deps, {
      ...BASE_INPUT,
      actorHumanId: ADMIN_ID,
    });

    expect(result.placeId).toBe(NEW_PLACE_ID);
  });
});

describe("createCommunityPlace — the place it writes", () => {
  it("writes the place with NO owner, address public, and returns the picker fields", async () => {
    const h = buildHarness();

    const result = await createCommunityPlace(h.deps, BASE_INPUT);

    expect(h.mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
    const written = h.mocks.placesRepo.upsert.mock.calls[0]![0];
    expect(written.owner).toBeNull();
    expect(written.placeId).toBeNull();
    expect(written.locationMode).toBe("EXACT");
    expect(written.geo).toEqual(PIN);
    expect(written.address.countryCode).toBe("US");
    // Born ACTIVE / UNVERIFIED by the column defaults: neither is sent, so
    // nothing here can promote it.
    expect(written).not.toHaveProperty("status");
    expect(written).not.toHaveProperty("verificationStatus");
    // LISTED in the directory at birth (owner ruling 2026-10-14).
    expect(written.listedInDirectory).toBe(true);
    expect(h.rows.get(NEW_PLACE_ID)?.listedInDirectory).toBe(true);

    expect(result).toEqual({
      placeId: NEW_PLACE_ID,
      name: "Corner Bar South",
      formattedAddress: ADDRESS.formatted,
      city: "Nashville",
      region: "TN",
      lat: PIN.lat,
      lng: PIN.lng,
      timezone: "America/Chicago",
      status: "ACTIVE",
      verificationStatus: "UNVERIFIED",
    });
  });

  it("gets every create side effect: audit (ownerless), page, Main Space + Calendar, tax, timezone, search mark", async () => {
    const h = buildHarness();

    await createCommunityPlace(h.deps, BASE_INPUT);

    const rows = auditRows(h.mocks.auditRepo.log);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "created",
        "place.defaults_minted",
        "place.community_created",
      ]),
    );
    expect(rows.find((r) => r.action === "created")!.data).toMatchObject({
      ownerless: true,
      ownerType: null,
      ownerId: null,
      actorHumanId: MODERATOR_ID,
      name: "Corner Bar South",
    });

    expect(h.mocks.entityPagesRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "PLACE", ownerId: NEW_PLACE_ID }),
    );
    const spaces = await h.mocks.spacesFake.listByPlace({
      placeId: NEW_PLACE_ID,
    });
    expect(spaces.map((s) => s.name)).toEqual(["Main Space"]);
    const calendar =
      await h.mocks.calendarsFake.findDefaultForPlace(NEW_PLACE_ID);
    expect(calendar?.name).toBe("Main Calendar");
    expect(h.mocks.taxRateLookup.lookupByPostalCode).toHaveBeenCalled();
    expect(h.rows.get(NEW_PLACE_ID)?.admissionTaxRateBps).toBe(925);
    expect(h.rows.get(NEW_PLACE_ID)?.timezone).toBe("America/Chicago");
    expect(h.mocks.markSpy).toHaveBeenCalledTimes(1);
  });

  it("indexes the new place after commit (the real reindex, against a search fake)", async () => {
    const h = buildHarness({ withSearch: true });

    await createCommunityPlace(h.deps, BASE_INPUT);

    await vi.waitFor(() =>
      expect(h.search!.upsertDocuments).toHaveBeenCalledWith({
        documents: [
          expect.objectContaining({ type: "place", placeId: NEW_PLACE_ID }),
        ],
      }),
    );
  });

  it("reaches the directory: the search document is ACTIVE, listed, and links to the place's page", async () => {
    // Directory surfaces (search page, `listPlacesForDirectory`,
    // `countDirectory`) filter on `type = place AND listedInDirectory` (and
    // the index holds ACTIVE places only); the result links to the
    // EntityPage slug, falling back to `/places/id/{uuid}` when null.
    const h = buildHarness({ withSearch: true });
    // The page fake is write-only; let the reindex read back the page the
    // create wrote, as the adapter does.
    h.mocks.entityPagesRepo.getByOwner.mockImplementation((async () => {
      const call = h.mocks.entityPagesRepo.upsert.mock.calls[0];
      // `visibility` is the column default (PUBLIC) the adapter returns.
      return call
        ? { id: "page-1", bio: null, visibility: "PUBLIC", ...call[0] }
        : null;
    }) as never);

    await createCommunityPlace(h.deps, BASE_INPUT);

    const pageSlug = (
      h.mocks.entityPagesRepo.upsert.mock.calls[0]![0] as { slug: string }
    ).slug;
    expect(pageSlug).toBeTruthy();
    await vi.waitFor(() =>
      expect(h.search!.upsertDocuments).toHaveBeenCalledWith({
        documents: [
          expect.objectContaining({
            type: "place",
            placeId: NEW_PLACE_ID,
            status: "ACTIVE",
            listedInDirectory: true,
            pageSlug,
          }),
        ],
      }),
    );
  });

  it("audits the listing with the action and shape setPlaceDirectoryListing writes", async () => {
    const h = buildHarness();

    await createCommunityPlace(h.deps, BASE_INPUT);

    const listed = h.mocks.auditRepo.log.mock.calls
      .map((c) => c[0] as { action: string; entityId: string; data: unknown })
      .filter((r) => r.action === "place.directory_listed");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.entityId).toBe(NEW_PLACE_ID);
    expect(listed[0]!.data).toEqual({
      previous: false,
      next: true,
      reason: "Staff-created place listed (owner ruling 2026-10-14)",
      actorHumanId: MODERATOR_ID,
    });
  });

  it("can be picked by a community listing (passes resolveListingPlaceLocation)", async () => {
    const h = buildHarness();

    const { placeId } = await createCommunityPlace(h.deps, BASE_INPUT);

    await expect(
      resolveListingPlaceLocation(h.deps.repos, placeId),
    ).resolves.toMatchObject({
      placeId,
      addressText: ADDRESS.formatted,
      countryCode: "US",
      lat: PIN.lat,
      lng: PIN.lng,
      geohash6: expect.stringMatching(/^[0-9a-z]{6}$/),
    });
  });

  it("takes an address of only the formatted text, country and pin", async () => {
    const h = buildHarness();
    const { formatted, countryCode, lat, lng } = ADDRESS;

    await expect(
      createCommunityPlace(h.deps, {
        ...BASE_INPUT,
        address: { formatted, countryCode, lat, lng },
      }),
    ).resolves.toMatchObject({ placeId: NEW_PLACE_ID });
    expect(h.mocks.placesRepo.upsert.mock.calls[0]![0].address.line1).toBe("");
  });

  it("requires the pin: no lat/lng is invalid_input (parseInput), with no write", async () => {
    const h = buildHarness();
    const { lat: _lat, lng: _lng, ...noPin } = ADDRESS;

    await expect(
      createCommunityPlace(h.deps, { ...BASE_INPUT, address: noPin }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("refuses a name the content filter blocks", async () => {
    const h = buildHarness({ blocked: ["Corner"] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["name"] },
    });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });

  it("a throwing timezone lookup is reported under this use case, and the place is still created", async () => {
    const boom = new Error("tz index unavailable");
    const h = buildHarness({
      timezoneLookup: vi.fn(() => {
        throw boom;
      }),
    });

    const result = await createCommunityPlace(h.deps, BASE_INPUT);

    expect(result.placeId).toBe(NEW_PLACE_ID);
    expect(result.timezone).toBeNull();
    expect(h.mocks.reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: { useCase: "createCommunityPlace", stage: "timezone_lookup" },
      }),
    );
  });
});

describe("createCommunityPlace — idempotency", () => {
  it("replays the same clientKey + payload without a second write", async () => {
    const h = buildHarness();

    const first = await createCommunityPlace(h.deps, BASE_INPUT);
    // The first place now exists; a replay must not trip the duplicate
    // guard on it.
    const second = await createCommunityPlace(h.deps, BASE_INPUT);

    expect(second).toEqual(first);
    expect(h.mocks.placesRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses the same clientKey with a different payload", async () => {
    const h = buildHarness();

    await createCommunityPlace(h.deps, BASE_INPUT);

    await expect(
      createCommunityPlace(h.deps, { ...BASE_INPUT, name: "Corner Bar North" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("IDEMPOTENCY_LOCK_IN_PROGRESS while another request holds the key", async () => {
    const h = buildHarness();
    h.deps.idempotency = createFakeIdempotencyPort({ beginSequence: [false] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });
    expect(h.mocks.tx).not.toHaveBeenCalled();
  });
});

describe("createCommunityPlace — duplicate guard (in the transaction)", () => {
  it("refuses a same-name place within 50 m, whatever its case and spacing, and hands it back", async () => {
    // "corner  bar SOUTH": the old ILIKE `contains` never returned this row.
    const nearby = makePlace({
      name: "corner  bar SOUTH",
      lat: PIN.lat + 0.0002,
    });
    const h = buildHarness({ places: [nearby] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: {
        existingPlace: {
          placeId: EXISTING_PLACE_ID,
          name: "corner  bar SOUTH",
          lat: nearby.lat,
          lng: nearby.lng,
        },
      },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
  });

  it("takes the name lock BEFORE reading candidates, inside the transaction", async () => {
    const h = buildHarness();

    await createCommunityPlace(h.deps, BASE_INPUT);

    expect(h.finder.calls.slice(0, 2)).toEqual([
      "lock:corner bar south",
      "find",
    ]);
    expect(h.mocks.tx).toHaveBeenCalledTimes(1);
    expect(h.order.indexOf("lockPlaceName:corner bar south")).toBeLessThan(
      h.order.indexOf("upsert"),
    );
  });

  it("re-checks under the lock: a same-name place committed while it waited is refused", async () => {
    // Models the competing create that held the name lock and committed: its
    // row appears the moment this one's lock is granted.
    const h = buildHarness({
      onNameLock: () => {
        h.rows.set(OTHER_PLACE_ID, makePlace({ id: OTHER_PLACE_ID }));
      },
    });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(h.mocks.placesRepo.upsert).not.toHaveBeenCalled();
    // The claim is released (not failed), so a corrected retry proceeds.
    expect(h.mocks.idempotency.release).toHaveBeenCalled();
  });

  it("refuses a same-name place at the same address text, wherever its pin is", async () => {
    const sameAddress = makePlace({
      lat: 0,
      lng: 0,
      formattedAddress: ADDRESS.formatted,
    });
    const h = buildHarness({ places: [sameAddress] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).rejects.toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
    });
  });

  it("creates when the same-name place is farther than 50 m", async () => {
    // ~0.001° of latitude is ~111 m.
    const h = buildHarness({ places: [makePlace({ lat: PIN.lat + 0.001 })] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      placeId: NEW_PLACE_ID,
    });
    expect(DUPLICATE_RADIUS_METERS).toBe(50);
  });

  it("creates when a nearby place only CONTAINS the name", async () => {
    const h = buildHarness({
      places: [makePlace({ name: "Corner Bar South Annex" })],
    });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      placeId: NEW_PLACE_ID,
    });
  });

  it("ignores an ARCHIVED same-name place", async () => {
    const h = buildHarness({ places: [makePlace({ status: "ARCHIVED" })] });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      placeId: NEW_PLACE_ID,
    });
  });

  it("never names a place that withholds its address, even at the same spot", async () => {
    const h = buildHarness({
      places: [makePlace({ locationMode: "OBSCURED" })],
    });

    await expect(createCommunityPlace(h.deps, BASE_INPUT)).resolves.toMatchObject({
      placeId: NEW_PLACE_ID,
    });
  });

  it("hands back the address-public duplicate, never a withheld one beside it", async () => {
    // The withheld row sorts FIRST by id, so only the filter keeps it out.
    const withheld = makePlace({ id: "aaaaaaaa-0000-4000-8000-000000000000", locationMode: "OBSCURED" });
    const exact = makePlace({ id: OTHER_PLACE_ID });
    const h = buildHarness({ places: [withheld, exact] });

    const error = await createCommunityPlace(h.deps, BASE_INPUT).then(
      () => {
        throw new Error("expected PLACE_ALREADY_EXISTS");
      },
      (e: unknown) => e as { code: string; meta: Record<string, unknown> },
    );

    expect(error).toMatchObject({
      code: "PLACE_ALREADY_EXISTS",
      meta: { existingPlace: { placeId: OTHER_PLACE_ID } },
    });
    expect(JSON.stringify(error.meta)).not.toContain(withheld.id);
  });
});

describe("normalizePlaceName", () => {
  it("ignores case, spacing and Unicode form", () => {
    expect(normalizePlaceName("  Corner  Bar  SOUTH ")).toBe(
      "corner bar south",
    );
  });
});
