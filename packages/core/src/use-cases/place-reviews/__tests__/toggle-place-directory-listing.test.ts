import { describe, expect, it, vi } from "vitest";

import { togglePlaceDirectoryListing } from "../toggle-place-directory-listing";
import type { TogglePlaceDirectoryListingDeps } from "../toggle-place-directory-listing";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PLACE_ID = "00000000-0000-4000-8000-00000000000a";
const ADMIN_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-04-07T12:00:00.000Z");

function makePlace(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    name: "The Basement East",
    formattedAddress: "917 Woodland St, Nashville, TN 37206",
    addressLine1: "917 Woodland St",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    listedInDirectory: false,
    ...overrides,
  };
}

function makeDeps(opts: {
  place?: unknown;
  isAdmin?: boolean;
  /** Stored flag at write time, when a concurrent toggle moved it. */
  storedListed?: boolean;
}): TogglePlaceDirectoryListingDeps {
  return {
    repos: withTx({
      places: {
        getById: vi.fn(async () => opts.place ?? null),
        // The adapter's compare-and-set against the stored flag.
        setDirectoryListing: vi.fn(async (input: any) => ({
          changed:
            (opts.storedListed ?? (opts.place as any)?.listedInDirectory) !==
            input.listedInDirectory,
        })),
      },
      audit: {
        log: vi.fn(async () => {}),
      },
      searchReindexPending: { mark: vi.fn(async () => {}) },
    }) as any,
    authz: {
      hasStaffRole: vi.fn(async () => ({
        allowed: opts.isAdmin !== false,
      })),
    },
    clock: { now: () => NOW },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

/**
 * The write, its audit row and its search reindex mark share one
 * `repos.tx`; this fake runs the callback against the same repos.
 */
function withTx<T extends object>(repos: T): T {
  return Object.assign(repos, {
    tx: vi.fn(async (fn: (tx: T) => Promise<unknown>) => fn(repos)),
  });
}

describe("togglePlaceDirectoryListing", () => {
  it("lists a place in directory when toggle is true", async () => {
    const deps = makeDeps({ place: makePlace(), isAdmin: true });

    const result = await togglePlaceDirectoryListing(deps, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: true,
    });

    expect(result).toEqual({ placeId: PLACE_ID, listedInDirectory: true });
    expect(deps.repos.places.setDirectoryListing).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      listedInDirectory: true,
    });
  });

  it("unlists a place from directory when toggle is false", async () => {
    const deps = makeDeps({
      place: makePlace({ listedInDirectory: true }),
      isAdmin: true,
    });

    const result = await togglePlaceDirectoryListing(deps, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: false,
    });

    expect(result).toEqual({ placeId: PLACE_ID, listedInDirectory: false });
  });

  it("logs audit entry for listing", async () => {
    const deps = makeDeps({ place: makePlace(), isAdmin: true });

    await togglePlaceDirectoryListing(deps, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: true,
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        entityId: PLACE_ID,
        action: "place.listed_in_directory",
      }),
    );
  });

  it("logs audit entry for unlisting", async () => {
    const deps = makeDeps({
      place: makePlace({ listedInDirectory: true }),
      isAdmin: true,
    });

    await togglePlaceDirectoryListing(deps, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: false,
    });

    expect(deps.repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        entityId: PLACE_ID,
        action: "place.unlisted_from_directory",
      }),
    );
  });

  it("throws forbidden when actor is not platform admin", async () => {
    const deps = makeDeps({ place: makePlace(), isAdmin: false });

    await expect(
      togglePlaceDirectoryListing(deps, {
        placeId: PLACE_ID,
        actorHumanId: ADMIN_ID,
        listedInDirectory: true,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("throws not_found when place does not exist", async () => {
    const deps = makeDeps({ place: null, isAdmin: true });

    await expect(
      togglePlaceDirectoryListing(deps, {
        placeId: PLACE_ID,
        actorHumanId: ADMIN_ID,
        listedInDirectory: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("writes only the flag, never the name/address read before the transaction", async () => {
    // The read happens before `repos.tx`; a moderator's concurrent
    // name/address/pin edit lands in between. Rebuilding the row from that
    // read (the old `places.upsert`) overwrote the edit. The narrow write
    // carries nothing but the flag, so there is nothing stale to write back.
    const deps = makeDeps({
      place: makePlace({ addressLine1: null, countryCode: null }),
      isAdmin: true,
    });
    (deps.repos.places as any).upsert = vi.fn();

    await togglePlaceDirectoryListing(deps, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: true,
    });

    expect((deps.repos.places as any).upsert).not.toHaveBeenCalled();
    const calls = (deps.repos.places.setDirectoryListing as any).mock.calls;
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0][0]).sort()).toEqual([
      "listedInDirectory",
      "placeId",
    ]);
  });

  it("marks for search only when the CAS moved the flag (not from the earlier read)", async () => {
    // Read says unlisted; a concurrent list committed first, so this list
    // call changes nothing and must not mark.
    const raced = makeDeps({
      place: makePlace({ listedInDirectory: false }),
      isAdmin: true,
      storedListed: true,
    });
    await togglePlaceDirectoryListing(raced, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: true,
    });
    expect((raced.repos as any).searchReindexPending.mark).not.toHaveBeenCalled();

    // Read says listed; a concurrent unlist committed first, so this list
    // call flips it and must mark.
    const flipped = makeDeps({
      place: makePlace({ listedInDirectory: true }),
      isAdmin: true,
      storedListed: false,
    });
    await togglePlaceDirectoryListing(flipped, {
      placeId: PLACE_ID,
      actorHumanId: ADMIN_ID,
      listedInDirectory: true,
    });
    expect((flipped.repos as any).searchReindexPending.mark).toHaveBeenCalledTimes(1);
  });
});
