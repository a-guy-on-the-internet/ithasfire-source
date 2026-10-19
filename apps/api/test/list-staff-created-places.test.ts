import { describe, expect, it, vi } from "vitest";

import {
  LISTING_REASON,
  isLocalHost,
  isUuid,
  listPlaces,
  partitionCandidates,
  resolveDbHost,
  type CandidateRow,
} from "../src/scripts/backfill/list-staff-created-places";

const ACTOR = "00000000-0000-4000-8000-000000000099";
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const row = (n: number, over: Partial<CandidateRow> = {}): CandidateRow => ({
  id: id(n),
  name: `Place ${n}`,
  createdAt: new Date("2026-10-13T12:00:00Z"),
  status: "ACTIVE",
  listedInDirectory: false,
  unlistedByStaff: false,
  ...over,
});

/** The real use case over an in-memory place table. */
function fakeDeps(
  listed: Map<string, boolean>,
  staff = true,
  status: Map<string, string> = new Map(),
) {
  const audit: Array<{ action: string; entityId: string; data: unknown }> = [];
  const marks: unknown[] = [];
  const repos = {
    places: {
      getById: vi.fn(async (pid: string) =>
        listed.has(pid)
          ? {
              id: pid,
              status: status.get(pid) ?? "ACTIVE",
              listedInDirectory: listed.get(pid)!,
            }
          : null,
      ),
      upsert: vi.fn(),
      // The adapter's compare-and-set.
      setDirectoryListing: vi.fn(
        async (i: { placeId: string; listedInDirectory: boolean }) => {
          const changed = listed.get(i.placeId) !== i.listedInDirectory;
          listed.set(i.placeId, i.listedInDirectory);
          return { changed };
        },
      ),
    },
    audit: { log: vi.fn(async (e: never) => void audit.push(e)) },
    searchReindexPending: { mark: vi.fn(async (t: unknown) => void marks.push(t)) },
    tx: async <T>(fn: (t: unknown) => Promise<T>) => fn(repos),
  };
  const deps = {
    repos,
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: staff })) },
    clock: { now: () => new Date("2026-10-14T12:00:00Z") },
  };
  return { deps: deps as never, repos, audit, marks };
}

describe("partitionCandidates", () => {
  it("lists ACTIVE unlisted places; skips archived and staff-unlisted ones; drops listed", () => {
    const p = partitionCandidates([
      row(1),
      row(2, { status: "ARCHIVED" }),
      row(3, { unlistedByStaff: true }),
      row(4, { listedInDirectory: true }),
      row(5, { status: "ARCHIVED", unlistedByStaff: true }),
    ]);
    expect(p.toList.map((r) => r.id)).toEqual([id(1)]);
    expect(p.skippedNotActive.map((r) => r.id)).toEqual([id(2), id(5)]);
    expect(p.skippedUnlistedByStaff.map((r) => r.id)).toEqual([id(3)]);
  });
});

describe("listPlaces (through setPlaceDirectoryListing)", () => {
  it("lists each place with one narrow write, one audit row and one search mark", async () => {
    const table = new Map([
      [id(1), false],
      [id(2), false],
    ]);
    const h = fakeDeps(table);

    const summary = await listPlaces(h.deps, [id(1), id(2)], ACTOR);

    expect(summary).toEqual({ listed: 2, skipped: 0, failed: 0 });
    expect([...table.values()]).toEqual([true, true]);
    expect(h.repos.places.upsert).not.toHaveBeenCalled();
    expect(h.audit).toHaveLength(2);
    expect(h.audit[0]).toMatchObject({
      action: "place.directory_listed",
      entityId: id(1),
      data: {
        previous: false,
        next: true,
        reason: LISTING_REASON,
        actorHumanId: ACTOR,
      },
    });
    expect(h.marks).toHaveLength(2);
  });

  it("is idempotent: once listed, the partition selects nothing", async () => {
    const table = new Map([[id(1), false]]);
    const h = fakeDeps(table);
    await listPlaces(h.deps, [id(1)], ACTOR);

    const again = partitionCandidates([
      row(1, { listedInDirectory: table.get(id(1))! }),
    ]);
    expect(again.toList).toEqual([]);
  });

  it("stops at once when the actor is not ADMIN/REVIEWER", async () => {
    const table = new Map([
      [id(1), false],
      [id(2), false],
    ]);
    const h = fakeDeps(table, false);

    await expect(listPlaces(h.deps, [id(1), id(2)], ACTOR)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect([...table.values()]).toEqual([false, false]);
    expect(h.audit).toHaveLength(0);
  });

  it("re-reads each place: one gone or archived since the selection is skipped, not listed", async () => {
    const table = new Map([
      [id(2), false],
      [id(3), false],
    ]);
    const h = fakeDeps(table, true, new Map([[id(3), "ARCHIVED"]]));

    const summary = await listPlaces(h.deps, [id(1), id(2), id(3)], ACTOR);

    expect(summary).toEqual({ listed: 1, skipped: 2, failed: 0 });
    expect(table.get(id(2))).toBe(true);
    expect(table.get(id(3))).toBe(false);
    expect(h.audit.map((a) => a.entityId)).toEqual([id(2)]);
  });

  it("counts a refusal after the first place as failed and carries on", async () => {
    const table = new Map([
      [id(1), false],
      [id(2), false],
    ]);
    const h = fakeDeps(table);
    h.repos.audit.log
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw { code: "dependency_failed" };
      });
    const onError = vi.fn();

    const summary = await listPlaces(h.deps, [id(1), id(2)], ACTOR, onError);

    expect(summary).toEqual({ listed: 1, skipped: 0, failed: 1 });
    expect(onError).toHaveBeenCalledWith(
      id(2),
      expect.objectContaining({ code: "dependency_failed" }),
    );
  });
});

describe("--actor", () => {
  it("must be a UUID", () => {
    expect(isUuid(ACTOR)).toBe(true);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid("dev-login")).toBe(false);
    expect(isUuid(`${ACTOR} `)).toBe(false);
  });
});

describe("host guard", () => {
  it("resolves the host getPrisma connects to and accepts only local ones", () => {
    expect(resolveDbHost("postgresql://u:p@localhost:5432/dev")).toBe("localhost");
    expect(resolveDbHost("postgresql://u:p@[::1]:5432/dev")).toBe("::1");
    expect(isLocalHost("::1")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
    const neon = resolveDbHost(
      "postgres://u:p@ep-x-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(isLocalHost(neon)).toBe(false);
  });
});
