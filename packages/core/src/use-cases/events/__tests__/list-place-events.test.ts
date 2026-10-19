import { describe, expect, it, vi } from "vitest";

import type { PlaceRecord } from "@th/ports/repos/places";

import { listPlaceEvents, type ListPlaceEventsDeps } from "../list-place-events";

// Public place listing — venue-confirmation spec (docs/specs/2026-08-27):
// only the venue's own events and the third-party ones it vouched for are
// listed. The rule lives in SQL (`venueConfirmedFor`), so what is pinned here
// is the argument that reaches the repo, keyed on the place's owner ids.

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const HUMAN_ID = "11111111-1111-4111-8111-111111111111";

function buildDeps(place: Partial<PlaceRecord> | null) {
  const listPublishedByPlace = vi.fn(async () => ({
    items: [],
    pageInfo: { total: 0, limit: 20, offset: 0, count: 0, hasMore: false },
  }));
  const deps = {
    repos: {
      places: {
        getById: vi.fn(async () =>
          place
            ? { id: PLACE_ID, status: "ACTIVE", orgIdsWithAccess: [], humanIdsWithAccess: [], ...place }
            : null,
        ),
      },
      events: { listPublishedByPlace },
    } as unknown as ListPlaceEventsDeps["repos"],
  } satisfies ListPlaceEventsDeps;
  return { deps, listPublishedByPlace };
}

const input = {
  placeId: PLACE_ID,
  status: "upcoming" as const,
  timeWindow: { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") },
};

describe("listPlaceEvents — venue confirmation", () => {
  it("passes venueConfirmedFor (the place's owner ids) to listPublishedByPlace", async () => {
    const { deps, listPublishedByPlace } = buildDeps({
      orgIdsWithAccess: [ORG_ID],
      humanIdsWithAccess: [HUMAN_ID],
    });
    await listPlaceEvents(deps, input);
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        status: "upcoming",
        venueConfirmedFor: {
          orgIds: [ORG_ID],
          humanIds: [HUMAN_ID],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  it("an ownerless (unclaimed) place still filters — empty sets match stamped events only", async () => {
    const { deps, listPublishedByPlace } = buildDeps({});
    await listPlaceEvents(deps, input);
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        venueConfirmedFor: {
          orgIds: [],
          humanIds: [],
          acceptsCommunityListings: false,
        },
      }),
    );
  });

  it("PLACE_NOT_FOUND for a missing or archived place, before any event read", async () => {
    const missing = buildDeps(null);
    await expect(listPlaceEvents(missing.deps, input)).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    const archived = buildDeps({ status: "ARCHIVED" });
    await expect(listPlaceEvents(archived.deps, input)).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(missing.listPublishedByPlace).not.toHaveBeenCalled();
    expect(archived.listPublishedByPlace).not.toHaveBeenCalled();
  });
});
