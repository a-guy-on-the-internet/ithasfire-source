import { describe, expect, it, vi } from "vitest";

import { setPlaceDirectoryListing } from "../set-place-directory-listing";
import type { SetPlaceDirectoryListingDeps } from "../set-place-directory-listing";

const PLACE_ID = "00000000-0000-4000-8000-00000000000a";
const ACTOR_ID = "00000000-0000-4000-8000-000000000099";
const NOW = new Date("2026-10-14T12:00:00.000Z");

function makePlace(overrides: Record<string, unknown> = {}) {
  return {
    id: PLACE_ID,
    name: "Name read before the transaction",
    formattedAddress: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    countryCode: null,
    lat: 36.1,
    lng: -86.7,
    status: "ACTIVE",
    verificationStatus: "UNVERIFIED",
    listedInDirectory: false,
    ...overrides,
  };
}

function makeDeps(
  opts: {
    place?: unknown;
    staff?: boolean;
    /** Flag value a concurrent toggle commits between the read and the tx. */
    flippedBeforeTx?: boolean;
  } = {},
) {
  const log: string[] = [];
  const place = "place" in opts ? opts.place : makePlace();
  // The stored flag: the CAS reads this, not the earlier `getById` result.
  const row = {
    listedInDirectory: (place as { listedInDirectory?: boolean } | null)
      ?.listedInDirectory,
  };
  const repos = {
    places: {
      getById: vi.fn(async () => {
        const out = place ?? null;
        if (opts.flippedBeforeTx !== undefined) {
          row.listedInDirectory = opts.flippedBeforeTx;
        }
        return out;
      }),
      upsert: vi.fn(),
      // The adapter's compare-and-set: writes only while the row holds the
      // opposite value.
      setDirectoryListing: vi.fn(async (input: { listedInDirectory: boolean }) => {
        log.push("place.setDirectoryListing");
        if (row.listedInDirectory === input.listedInDirectory) {
          return { changed: false };
        }
        row.listedInDirectory = input.listedInDirectory;
        return { changed: true };
      }),
    },
    audit: { log: vi.fn(async () => void log.push("audit")) },
    searchReindexPending: {
      mark: vi.fn(async () => void log.push("mark")),
    },
    tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => {
      log.push("tx:open");
      const out = await fn(repos);
      log.push("tx:commit");
      return out;
    }),
  };
  const deps = {
    repos,
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed: opts.staff !== false })),
    },
    clock: { now: () => NOW },
  } as unknown as SetPlaceDirectoryListingDeps;
  return { deps, repos, log, row };
}

describe("setPlaceDirectoryListing", () => {
  it("writes only the flag, never the row read before the transaction", async () => {
    // A moderator's `updateCommunityPlace` can change name/address/pin
    // between the read and this transaction. The old whole-row
    // `places.upsert` wrote the stale read back over it (and NULL line1 /
    // country as ""). The narrow write carries nothing but the flag.
    const { deps, repos } = makeDeps();

    const out = await setPlaceDirectoryListing(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      listedInDirectory: true,
    });

    expect(out).toEqual({ placeId: PLACE_ID, listedInDirectory: true });
    expect(repos.places.upsert).not.toHaveBeenCalled();
    expect(repos.places.setDirectoryListing).toHaveBeenCalledTimes(1);
    expect(repos.places.setDirectoryListing).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      listedInDirectory: true,
    });
  });

  it("writes, audits and marks for search in one transaction", async () => {
    const { deps, repos, log } = makeDeps();

    await setPlaceDirectoryListing(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      listedInDirectory: true,
      reason: "Staff-created place listed (owner ruling 2026-10-14)",
    });

    expect(log.filter((l) => l !== "mark")).toEqual([
      "tx:open",
      "place.setDirectoryListing",
      "audit",
      "tx:commit",
    ]);
    expect(log.indexOf("mark")).toBeGreaterThan(log.indexOf("audit"));
    expect(log.indexOf("mark")).toBeLessThan(log.indexOf("tx:commit"));
    expect(repos.audit.log).toHaveBeenCalledWith({
      entity: "place",
      entityId: PLACE_ID,
      action: "place.directory_listed",
      data: {
        previous: false,
        next: true,
        reason: "Staff-created place listed (owner ruling 2026-10-14)",
        actorHumanId: ACTOR_ID,
      },
      at: NOW,
    });
  });

  it("already listed: the CAS changes nothing, no mark, still audits the intent", async () => {
    const { deps, repos, log, row } = makeDeps({
      place: makePlace({ listedInDirectory: true }),
    });

    await setPlaceDirectoryListing(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      listedInDirectory: true,
    });

    expect(row.listedInDirectory).toBe(true);
    expect(log).not.toContain("mark");
    expect(repos.audit.log).toHaveBeenCalledTimes(1);
    expect(repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ previous: true, next: true }),
      }),
    );
  });

  it("race: read says listed, a concurrent unlist commits first: lists it, audits previous:false, marks", async () => {
    // Staff A reads listed=true; staff B's unlist commits; A's list call
    // must still list the place. Taking `changed` from the stale read
    // skipped the write and the mark and audited previous:true while the
    // place stayed unlisted.
    const { deps, repos, log, row } = makeDeps({
      place: makePlace({ listedInDirectory: true }),
      flippedBeforeTx: false,
    });

    await setPlaceDirectoryListing(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      listedInDirectory: true,
    });

    expect(row.listedInDirectory).toBe(true);
    expect(repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "place.directory_listed",
        data: expect.objectContaining({ previous: false, next: true }),
      }),
    );
    expect(log).toContain("mark");
  });

  it("race: read says unlisted, a concurrent list commits first: no false flip in the audit, no mark", async () => {
    const { deps, repos, log, row } = makeDeps({
      place: makePlace({ listedInDirectory: false }),
      flippedBeforeTx: true,
    });

    await setPlaceDirectoryListing(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      listedInDirectory: true,
    });

    expect(row.listedInDirectory).toBe(true);
    expect(repos.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ previous: true, next: true }),
      }),
    );
    expect(log).not.toContain("mark");
  });

  it("refuses a non-staff actor before reading the place", async () => {
    const { deps, repos } = makeDeps({ staff: false });

    await expect(
      setPlaceDirectoryListing(deps, {
        actorHumanId: ACTOR_ID,
        placeId: PLACE_ID,
        listedInDirectory: true,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(repos.places.getById).not.toHaveBeenCalled();
    expect(repos.tx).not.toHaveBeenCalled();
  });

  it("unknown place: PLACE_NOT_FOUND, nothing written", async () => {
    const { deps, repos } = makeDeps({ place: null });

    await expect(
      setPlaceDirectoryListing(deps, {
        actorHumanId: ACTOR_ID,
        placeId: PLACE_ID,
        listedInDirectory: true,
      }),
    ).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
    expect(repos.tx).not.toHaveBeenCalled();
  });
});
