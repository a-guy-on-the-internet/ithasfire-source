import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { VolunteerPackWithRolesRecord } from "@th/ports/repos/volunteering";

import {
  listVolunteerPacks,
  listVolunteerPacksOutputSchema,
  type ListVolunteerPacksDeps,
} from "./list-volunteer-packs";

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const CATEGORY_ID = "00000000-0000-4000-8000-000000000040";
const OTHER_CATEGORY_ID = "00000000-0000-4000-8000-000000000041";
const NOW = new Date("2026-07-28T12:00:00.000Z");

function pack(
  overrides: Partial<VolunteerPackWithRolesRecord> & { key: string },
): VolunteerPackWithRolesRecord {
  return {
    id: `pack-${overrides.key}`,
    name: overrides.key,
    blurb: null,
    status: "LIVE",
    targetCategoryIds: [],
    rankFirst: false,
    sortOrder: 0,
    curatedByHumanId: null,
    createdAt: NOW,
    updatedAt: NOW,
    roles: [],
    ...overrides,
  };
}

function makeDeps(
  packs: VolunteerPackWithRolesRecord[],
  authzOverride?: Record<string, unknown>,
) {
  const txRepos = {
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "VIEWER" })),
      ...authzOverride,
    },
    volunteering: {
      listLivePacksWithRoles: vi.fn(async () => packs),
    },
  };
  const deps: ListVolunteerPacksDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
  };
  return { deps, txRepos };
}

describe("listVolunteerPacks", () => {
  const validInput = { actorHumanId: ACTOR_ID, orgId: ORG_ID };

  it("reads the LIVE-only repo method (DRAFT packs cannot leak)", async () => {
    const { deps, txRepos } = makeDeps([]);
    await listVolunteerPacks(deps, validInput);
    expect(txRepos.volunteering.listLivePacksWithRoles).toHaveBeenCalledTimes(
      1,
    );
    // There is no status argument to get wrong: the read is LIVE by
    // construction, so a DRAFT pack is unreachable from this path.
    expect(txRepos.volunteering.listLivePacksWithRoles).toHaveBeenCalledWith();
  });

  it("returns packs with their roles", async () => {
    const { deps } = makeDeps([
      pack({
        key: "house-show",
        roles: [
          {
            id: "role-1",
            orgId: null,
            name: "Door",
            description: null,
            defaultCapacity: 2,
            sortOrder: 0,
            archived: false,
            isPlatform: true,
            packId: "pack-house-show",
            createdAt: NOW,
            updatedAt: NOW,
            shifts: [],
          },
        ],
      }),
    ]);
    const result = await listVolunteerPacks(deps, validInput);
    expect(result).toHaveLength(1);
    expect(result[0]!.roles[0]).toMatchObject({ name: "Door" });
  });

  it("marks category matches without filtering anything out", async () => {
    const { deps } = makeDeps([
      pack({ key: "a", targetCategoryIds: [OTHER_CATEGORY_ID] }),
      pack({ key: "b", targetCategoryIds: [CATEGORY_ID] }),
    ]);
    const result = await listVolunteerPacks(deps, {
      ...validInput,
      categoryId: CATEGORY_ID,
    });
    expect(result.map((p) => p.key)).toEqual(["b", "a"]);
    expect(result.map((p) => p.categoryMatch)).toEqual([true, false]);
  });

  it("ranks pinned packs above category matches", async () => {
    const { deps } = makeDeps([
      pack({ key: "matching", targetCategoryIds: [CATEGORY_ID] }),
      pack({ key: "pinned", rankFirst: true }),
    ]);
    const result = await listVolunteerPacks(deps, {
      ...validInput,
      categoryId: CATEGORY_ID,
    });
    expect(result.map((p) => p.key)).toEqual(["pinned", "matching"]);
  });

  it("falls back to curation order then name", async () => {
    const { deps } = makeDeps([
      pack({ key: "z", name: "Zed", sortOrder: 1 }),
      pack({ key: "b", name: "Bee", sortOrder: 0 }),
      pack({ key: "a", name: "Aye", sortOrder: 0 }),
    ]);
    const result = await listVolunteerPacks(deps, validInput);
    expect(result.map((p) => p.name)).toEqual(["Aye", "Bee", "Zed"]);
  });

  it("marks nothing as matching when no category is supplied", async () => {
    const { deps } = makeDeps([
      pack({ key: "a", targetCategoryIds: [CATEGORY_ID] }),
    ]);
    const result = await listVolunteerPacks(deps, validInput);
    expect(result[0]!.categoryMatch).toBe(false);
  });

  it("still returns the whole catalogue when nothing targets the category", async () => {
    const { deps } = makeDeps([pack({ key: "a" }), pack({ key: "b" })]);
    const result = await listVolunteerPacks(deps, {
      ...validInput,
      categoryId: CATEGORY_ID,
    });
    expect(result).toHaveLength(2);
  });

  it("rejects a non-member", async () => {
    const { deps } = makeDeps([], {
      getOrgMembership: vi.fn(async () => null),
    });
    await expect(listVolunteerPacks(deps, validInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects unknown input fields", async () => {
    const { deps } = makeDeps([]);
    await expect(
      listVolunteerPacks(deps, { ...validInput, status: "DRAFT" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("returns a shape the transport `.output()` schema accepts", async () => {
    // The router now declares `.output(listVolunteerPacksOutputSchema)`, and
    // that schema is `.strict()` all the way down: an unlisted field on the
    // record would 500 the procedure rather than leak. Round-trip a realistic
    // pack — anchored shift preset included — through it.
    const PACK_UUID = "00000000-0000-4000-8000-000000000050";
    const ROLE_UUID = "00000000-0000-4000-8000-000000000051";
    const SHIFT_UUID = "00000000-0000-4000-8000-000000000052";
    const { deps } = makeDeps([
      pack({
        id: PACK_UUID,
        key: "house-show",
        blurb: "Six roles for a living-room gig.",
        targetCategoryIds: [CATEGORY_ID],
        curatedByHumanId: ACTOR_ID,
        roles: [
          {
            id: ROLE_UUID,
            orgId: null,
            name: "Door",
            description: "Greet and check tickets",
            defaultCapacity: 2,
            sortOrder: 0,
            archived: false,
            isPlatform: true,
            packId: PACK_UUID,
            createdAt: NOW,
            updatedAt: NOW,
            shifts: [
              {
                id: SHIFT_UUID,
                templateId: ROLE_UUID,
                label: "Load-in",
                startMinuteOfDay: 960,
                endMinuteOfDay: 1110,
                startDayOffset: 0,
                endsNextDay: false,
                capacity: 2,
                position: 0,
                anchor: "EVENT_START",
                offsetMinutes: -180,
                notes: "Meet at the loading dock",
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      }),
    ]);

    const result = await listVolunteerPacks(deps, {
      ...validInput,
      categoryId: CATEGORY_ID,
    });
    const parsed = listVolunteerPacksOutputSchema.parse(result);
    expect(parsed[0]?.categoryMatch).toBe(true);
    expect(parsed[0]?.roles[0]?.shifts[0]?.anchor).toBe("EVENT_START");
  });
});
