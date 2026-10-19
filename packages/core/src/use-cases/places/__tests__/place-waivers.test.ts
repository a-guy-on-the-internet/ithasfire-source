import { describe, it, expect, vi } from "vitest";
import {
  createPlaceWaiver,
  updatePlaceWaiver,
  deletePlaceWaiver,
  listPlaceWaivers,
  getActivePlaceWaiver,
  type PlaceWaiverDeps,
} from "../place-waivers";

const PLACE_ID = "aaaa0000-0000-4000-8000-000000000001";
const ACTOR_ID = "bbbb0000-0000-4000-8000-000000000002";
const ORG_ID = "cccc0000-0000-4000-8000-000000000003";
const WAIVER_ID = "dddd0000-0000-4000-8000-000000000004";

function makeDeps(overrides?: {
  placeAccessCtx?: {
    placeId: string;
    owningOrgIds: string[];
    verifiedHumanOwnerIds: string[];
  } | null;
  membership?: { role: string } | null;
  activeWaiver?: any | null;
}): PlaceWaiverDeps {
  const hasCtxOverride =
    overrides !== undefined && "placeAccessCtx" in (overrides ?? {});
  const ctx = hasCtxOverride
    ? overrides!.placeAccessCtx
    : {
        placeId: PLACE_ID,
        owningOrgIds: [ORG_ID],
        verifiedHumanOwnerIds: [],
      };
  const hasMembershipOverride =
    overrides !== undefined && "membership" in (overrides ?? {});
  const membership = hasMembershipOverride
    ? overrides!.membership
    : { role: "OWNER" };

  return {
    repos: {
      authz: {
        getPlaceAccessContext: vi.fn(async () => ctx),
        getOrgMembership: vi.fn(async () => membership),
      },
      placeWaivers: {
        getById: vi.fn(async (id: string) =>
          id === WAIVER_ID
            ? {
                id: WAIVER_ID,
                placeId: PLACE_ID,
                title: "Liability Waiver",
                content: "You agree to all the things.",
                version: 1,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              }
            : null,
        ),
        create: vi.fn(async (input: any) => ({
          id: "new-waiver-id",
          placeId: input.placeId,
          title: input.title,
          content: input.content,
          version: 2,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        update: vi.fn(async (input: any) => ({
          id: input.id,
          placeId: PLACE_ID,
          title: input.title ?? "Liability Waiver",
          content: input.content ?? "You agree to all the things.",
          version: 1,
          isActive: input.isActive ?? true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        delete: vi.fn(async () => {}),
        listByPlace: vi.fn(async () => []),
        getActiveForPlace: vi.fn(async () => overrides?.activeWaiver ?? null),
      },
    } as unknown as PlaceWaiverDeps["repos"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    } as any,
  };
}

describe("createPlaceWaiver", () => {
  it("creates a new waiver and deactivates previous active", async () => {
    const oldWaiver = {
      id: "old-waiver",
      placeId: PLACE_ID,
      version: 1,
      isActive: true,
    };
    const deps = makeDeps({ activeWaiver: oldWaiver });

    const result = await createPlaceWaiver(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      title: "Updated Liability Waiver",
      content: "New waiver content here.",
    });

    expect(result.title).toBe("Updated Liability Waiver");
    expect(result.isActive).toBe(true);
    // Old waiver should have been deactivated
    expect(deps.repos.placeWaivers.update as any).toHaveBeenCalledWith({
      id: "old-waiver",
      isActive: false,
    });
  });

  it("creates first waiver when none exists", async () => {
    const deps = makeDeps({ activeWaiver: null });

    const result = await createPlaceWaiver(deps, {
      actorHumanId: ACTOR_ID,
      placeId: PLACE_ID,
      title: "First Waiver",
      content: "Some content.",
    });

    expect(result.isActive).toBe(true);
    expect(deps.repos.placeWaivers.update as any).not.toHaveBeenCalled();
  });

  it("rejects when actor has no place access", async () => {
    const deps = makeDeps({ membership: null });
    await expect(
      createPlaceWaiver(deps, {
        actorHumanId: ACTOR_ID,
        placeId: PLACE_ID,
        title: "Waiver",
        content: "Content.",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects empty title", async () => {
    const deps = makeDeps();
    await expect(
      createPlaceWaiver(deps, {
        actorHumanId: ACTOR_ID,
        placeId: PLACE_ID,
        title: "",
        content: "Content.",
      }),
    ).rejects.toThrow();
  });
});

describe("updatePlaceWaiver", () => {
  it("updates title of existing waiver", async () => {
    const deps = makeDeps();
    const result = await updatePlaceWaiver(deps, {
      actorHumanId: ACTOR_ID,
      id: WAIVER_ID,
      title: "Revised Title",
    });

    expect(deps.repos.placeWaivers.update as any).toHaveBeenCalledWith({
      id: WAIVER_ID,
      title: "Revised Title",
      content: undefined,
      isActive: undefined,
    });
  });

  it("rejects when waiver not found", async () => {
    const deps = makeDeps();
    await expect(
      updatePlaceWaiver(deps, {
        actorHumanId: ACTOR_ID,
        id: "00000000-0000-4000-8000-000000000099",
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "WAIVER_NOT_FOUND" });
  });
});

describe("deletePlaceWaiver", () => {
  it("deletes an existing waiver", async () => {
    const deps = makeDeps();
    await deletePlaceWaiver(deps, {
      actorHumanId: ACTOR_ID,
      id: WAIVER_ID,
    });

    expect(deps.repos.placeWaivers.delete as any).toHaveBeenCalledWith(
      WAIVER_ID,
    );
  });
});

describe("listPlaceWaivers", () => {
  it("lists all waivers for a place", async () => {
    const deps = makeDeps();
    await listPlaceWaivers(deps, { placeId: PLACE_ID });

    expect(deps.repos.placeWaivers.listByPlace as any).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      activeOnly: false,
    });
  });
});

describe("getActivePlaceWaiver", () => {
  it("returns null when no active waiver", async () => {
    const deps = makeDeps({ activeWaiver: null });
    const result = await getActivePlaceWaiver(deps, { placeId: PLACE_ID });
    expect(result).toBeNull();
  });

  it("returns the active waiver", async () => {
    const waiver = {
      id: WAIVER_ID,
      placeId: PLACE_ID,
      isActive: true,
      version: 1,
    };
    const deps = makeDeps({ activeWaiver: waiver });
    const result = await getActivePlaceWaiver(deps, { placeId: PLACE_ID });
    expect(result?.id).toBe(WAIVER_ID);
  });
});
