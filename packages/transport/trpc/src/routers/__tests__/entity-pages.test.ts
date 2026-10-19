import { beforeEach, describe, expect, it, vi } from "vitest";

import * as entityPageUseCases from "@th/core/use-cases/entity-pages";
import * as resolveCommunityHandoverModule from "@th/core/use-cases/entity-pages/resolve-community-handover";
import { AppError } from "@th/errors";
import { entityPagesRouter, isBlockActionGated } from "../entity-pages";
import { createCaller } from "./test-helpers";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = ACTOR_ID; // HUMAN page owned by the actor

const createEntityPagesCaller = (
  ctxOverrides?: Parameters<typeof createCaller>[1],
) => createCaller(entityPagesRouter, ctxOverrides);

const withAction = (
  blockAction:
    | { action: "add"; kind: string }
    | { action: "edit"; blockId: string; kind?: string; data?: unknown }
    | { action: "reorder"; orderedBlockIds: string[] }
    | { action: "toggleVisibility"; blockId: string }
    | { action: "delete"; blockId: string },
) => ({
  ownerType: "HUMAN" as const,
  ownerId: OWNER_ID,
  blockAction,
});

const blockInput = withAction({ action: "delete", blockId: "block-1" });

// Structural actions — must stay behind the entityPageEditor gate. A
// kind-bearing edit transmutes a block into a different type ("add" by
// replacement), so it is structural too.
const gatedActions = [
  withAction({ action: "add", kind: "text" }),
  withAction({ action: "delete", blockId: "block-1" }),
  withAction({ action: "reorder", orderedBlockIds: ["block-1", "block-2"] }),
  withAction({
    action: "edit",
    blockId: "block-1",
    kind: "text",
    data: { text: "hi" },
  }),
];

// Content/visibility actions on existing blocks — always allowed.
const ungatedActions = [
  withAction({ action: "edit", blockId: "block-1", data: { text: "hi" } }),
  withAction({ action: "toggleVisibility", blockId: "block-1" }),
];

describe("entityPagesRouter.managePageBlocks feature gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("proceeds when the entityPageEditor gate is ON (env)", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "managePageBlocks")
      .mockResolvedValue({ block: null, blocks: [] });

    const { caller } = createEntityPagesCaller({
      actorHumanId: ACTOR_ID,
      enableEntityPageEditor: true,
    });

    const result = await caller.managePageBlocks(blockInput);

    expect(result).toEqual({ block: null, blocks: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: OWNER_ID,
      }),
    );
  });

  it("rejects with FORBIDDEN and performs NO write when the gate is off (env default)", async () => {
    const spy = vi.spyOn(entityPageUseCases, "managePageBlocks");

    // No enableEntityPageEditor override and no platformSettings repo → the
    // gate resolves to its default-OFF state.
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    await expect(caller.managePageBlocks(blockInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("honours a DB override turning the editor ON even when env leaves it off", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "managePageBlocks")
      .mockResolvedValue({ block: null, blocks: [] });

    const { caller } = createEntityPagesCaller({
      actorHumanId: ACTOR_ID,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([
              { key: "feature:entityPageEditor", value: "true" },
            ]),
        },
      } as any,
    });

    const result = await caller.managePageBlocks(blockInput);

    expect(result).toEqual({ block: null, blocks: [] });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("honours a DB override turning the editor off even when env enables it", async () => {
    const spy = vi.spyOn(entityPageUseCases, "managePageBlocks");

    const { caller } = createEntityPagesCaller({
      actorHumanId: ACTOR_ID,
      enableEntityPageEditor: true,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([
              { key: "feature:entityPageEditor", value: "false" },
            ]),
        },
      } as any,
    });

    await expect(caller.managePageBlocks(blockInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Per-action gating: structural vs content ─────────────────────────────

  it("rejects each structural action (add/delete/reorder/kind-edit) with FORBIDDEN when the gate is off", async () => {
    const spy = vi.spyOn(entityPageUseCases, "managePageBlocks");

    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    for (const input of gatedActions) {
      await expect(caller.managePageBlocks(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows edit and toggleVisibility through to the use case even when the gate is off", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "managePageBlocks")
      .mockResolvedValue({ block: null, blocks: [] });

    // No enableEntityPageEditor override and no platformSettings repo → the
    // gate resolves to its default-OFF state; content edits and visibility
    // toggles on template-seeded blocks must still pass.
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    for (const input of ungatedActions) {
      const result = await caller.managePageBlocks(input);
      expect(result).toEqual({ block: null, blocks: [] });
    }
    expect(spy).toHaveBeenCalledTimes(ungatedActions.length);
    expect(spy).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: OWNER_ID,
      }),
    );
  });

  it("allows every action when the gate is on", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "managePageBlocks")
      .mockResolvedValue({ block: null, blocks: [] });

    const { caller } = createEntityPagesCaller({
      actorHumanId: ACTOR_ID,
      enableEntityPageEditor: true,
    });

    for (const input of [...gatedActions, ...ungatedActions]) {
      const result = await caller.managePageBlocks(input);
      expect(result).toEqual({ block: null, blocks: [] });
    }
    expect(spy).toHaveBeenCalledTimes(
      gatedActions.length + ungatedActions.length,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBySlug — humanProfilesPublic gate (data-layer enforcement)
// ─────────────────────────────────────────────────────────────────────────────

type EntitySummary = Awaited<
  ReturnType<typeof entityPageUseCases.getPublicPage>
>["entity"];

const makeGetBySlugOutput = (
  entity: EntitySummary,
): Awaited<ReturnType<typeof entityPageUseCases.getPublicPage>> => ({
  page: {
    id: "page-1",
    ownerType: entity.type,
    ownerId: "owner-1",
    slug: "some-slug",
    displayName: "Some Name",
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: true,
    category: null,
    templateAppliedCategories: [],
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  },
  blocks: [],
  theme: null,
  entity,
  communityAttribution: null,
});

const humanEntity: EntitySummary = {
  type: "HUMAN",
  id: "human-1",
  name: "Ada Human",
  jobs: [],
  genreTags: [],
  otherJobDescription: null,
  acceptsBookingRequests: false,
};

const orgEntity: EntitySummary = {
  type: "ORGANIZATION",
  id: "org-1",
  name: "Bay Area Festivals",
  slug: "bay-area-festivals",
  trustTier: "COMMUNITY",
  trustBadgeLabel: null,
  acceptsBookingRequests: false,
};

const placeEntity: EntitySummary = {
  type: "PLACE",
  id: "place-1",
  name: "Red Rocks",
  slug: "red-rocks",
  formattedAddress: null,
  city: null,
  region: null,
  lat: null,
  lng: null,
};

describe("entityPagesRouter.getBySlug humanProfilesPublic gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("404s a HUMAN page when the gate is off (env default, no DB override)", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "getPublicPage")
      .mockResolvedValue(makeGetBySlugOutput(humanEntity));

    // No enableHumanProfilesPublic override and no platformSettings repo → the
    // gate resolves to its default-OFF state → HUMAN pages are hidden.
    const { caller } = createEntityPagesCaller({ actorHumanId: null });

    await expect(caller.getBySlug({ slug: "some-slug" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    // The use case still ran — the gate is enforced AFTER load, on the DTO.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resolves an ORGANIZATION page even when the gate is off", async () => {
    vi.spyOn(entityPageUseCases, "getPublicPage").mockResolvedValue(
      makeGetBySlugOutput(orgEntity),
    );

    const { caller } = createEntityPagesCaller({ actorHumanId: null });

    const result = await caller.getBySlug({ slug: "bay-area-festivals" });
    expect(result.entity.type).toBe("ORGANIZATION");
  });

  it("resolves a PLACE page even when the gate is off", async () => {
    vi.spyOn(entityPageUseCases, "getPublicPage").mockResolvedValue(
      makeGetBySlugOutput(placeEntity),
    );

    const { caller } = createEntityPagesCaller({ actorHumanId: null });

    const result = await caller.getBySlug({ slug: "red-rocks" });
    expect(result.entity.type).toBe("PLACE");
  });

  it("resolves a HUMAN page when the gate is ON (env)", async () => {
    vi.spyOn(entityPageUseCases, "getPublicPage").mockResolvedValue(
      makeGetBySlugOutput(humanEntity),
    );

    const { caller } = createEntityPagesCaller({
      actorHumanId: null,
      enableHumanProfilesPublic: true,
    });

    const result = await caller.getBySlug({ slug: "some-slug" });
    expect(result.entity.type).toBe("HUMAN");
  });

  it("resolves a HUMAN page when a DB override turns the gate ON (env off)", async () => {
    vi.spyOn(entityPageUseCases, "getPublicPage").mockResolvedValue(
      makeGetBySlugOutput(humanEntity),
    );

    const { caller } = createEntityPagesCaller({
      actorHumanId: null,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([
              { key: "feature:humanProfilesPublic", value: "true" },
            ]),
        },
      } as any,
    });

    const result = await caller.getBySlug({ slug: "some-slug" });
    expect(result.entity.type).toBe("HUMAN");
  });

  it("404s a HUMAN page when a DB override turns the gate off (env on)", async () => {
    const spy = vi
      .spyOn(entityPageUseCases, "getPublicPage")
      .mockResolvedValue(makeGetBySlugOutput(humanEntity));

    const { caller } = createEntityPagesCaller({
      actorHumanId: null,
      enableHumanProfilesPublic: true,
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([
              { key: "feature:humanProfilesPublic", value: "false" },
            ]),
        },
      } as any,
    });

    await expect(caller.getBySlug({ slug: "some-slug" })).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMyPage — the owner's entity must survive `.output()`
//
// The transport needs no logic change for this: `.output(getMyPageOutputSchema)`
// is the same schema object the use case parses with, so widening the use case
// widens the procedure. But tRPC's output parse STRIPS anything the schema does
// not declare, so a field that exists in core and not in the wire schema
// vanishes silently between server and client. These tests pin that the entity
// arrives intact — and that the parse really is running.
// ─────────────────────────────────────────────────────────────────────────────

describe("entityPagesRouter.getMyPage entity passthrough", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const myPageResult = (
    entity: Awaited<ReturnType<typeof entityPageUseCases.getMyPage>>["entity"],
  ): Awaited<ReturnType<typeof entityPageUseCases.getMyPage>> => ({
    page: {
      id: "page-1",
      ownerType: "PLACE",
      ownerId: "place-1",
      slug: "the-roxy",
      displayName: "The Roxy",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    blocks: [],
    theme: null,
    entity,
  });

  const verifiedVenue = {
    type: "PLACE" as const,
    id: "place-1",
    name: "The Roxy",
    formattedAddress: "9009 Sunset Blvd, West Hollywood, CA",
    city: "West Hollywood",
    region: "CA",
    lat: 34.09,
    lng: -118.39,
    capacity: 500,
    phone: "+13102782222",
    website: "https://theroxy.com",
    acceptsBookingRequests: true,
    verified: true,
  };

  it("returns the venue entity — booking flags and geo intact — through .output()", async () => {
    vi.spyOn(entityPageUseCases, "getMyPage").mockResolvedValue(
      myPageResult(verifiedVenue),
    );

    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    const result = await caller.getMyPage({
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    expect(result.entity).toEqual(verifiedVenue);
  });

  it("passes a null entity through rather than dropping the key", async () => {
    vi.spyOn(entityPageUseCases, "getMyPage").mockResolvedValue(
      myPageResult(null),
    );

    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    const result = await caller.getMyPage({
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    expect(result).toHaveProperty("entity");
    expect(result.entity).toBeNull();
  });

  it("strips an undeclared entity field, proving the output parse actually runs", async () => {
    // Guards the assertion above from being vacuously true: if `.output()` were
    // a no-op, this smuggled key would survive too.
    vi.spyOn(entityPageUseCases, "getMyPage").mockResolvedValue(
      myPageResult({
        ...verifiedVenue,
        verificationStatus: "VERIFIED",
      } as unknown as typeof verifiedVenue),
    );

    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });

    const result = await caller.getMyPage({
      ownerType: "PLACE",
      ownerId: "place-1",
    });

    expect(result.entity).not.toHaveProperty("verificationStatus");
    expect(result.entity).toMatchObject({ verified: true });
  });
});

describe("isBlockActionGated", () => {
  it("gates structural actions only", () => {
    expect(isBlockActionGated({ action: "add", kind: "text" })).toBe(true);
    expect(isBlockActionGated({ action: "delete" })).toBe(true);
    expect(isBlockActionGated({ action: "reorder" })).toBe(true);
    expect(isBlockActionGated({ action: "edit" })).toBe(false);
    expect(isBlockActionGated({ action: "toggleVisibility" })).toBe(false);
  });

  it("gates an edit that carries a kind (block-type transmutation)", () => {
    expect(isBlockActionGated({ action: "edit", kind: "text" })).toBe(true);
    // Absent (undefined) kind stays ungated — a plain data/visible edit.
    expect(isBlockActionGated({ action: "edit", kind: undefined })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Moderator place page: probe, attribution, owner handover (FR-005..FR-007)
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_UUID = "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("entityPagesRouter moderator place page procedures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getBySlug carries the community attribution through the output parse", async () => {
    const lastUpdatedAt = "2026-10-14T12:00:00.000Z";
    vi.spyOn(entityPageUseCases, "getPublicPage").mockResolvedValue({
      ...makeGetBySlugOutput(placeEntity),
      communityAttribution: { maintainedByCommunity: true, lastUpdatedAt },
    });
    const { caller } = createEntityPagesCaller({ actorHumanId: null });
    const result = await caller.getBySlug({ slug: "red-rocks" });
    expect(result.communityAttribution).toEqual({
      maintainedByCommunity: true,
      lastUpdatedAt,
    });
  });

  it("placePageEditAccess injects the session actor and returns the probe", async () => {
    const answer = {
      placeId: PLACE_UUID,
      canEditPage: true,
      editorKind: "community_moderator" as const,
      reason: null,
    };
    const spy = vi
      .spyOn(entityPageUseCases, "getPlacePageEditAccess")
      .mockResolvedValue(answer);
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.placePageEditAccess({ placeId: PLACE_UUID }),
    ).resolves.toEqual(answer);
    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      placeId: PLACE_UUID,
      actorHumanId: ACTOR_ID,
    });
  });

  it("placePageEditAccess refuses a client-sent actorHumanId", async () => {
    const spy = vi.spyOn(entityPageUseCases, "getPlacePageEditAccess");
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.placePageEditAccess({
        placeId: PLACE_UUID,
        actorHumanId: "someone-else",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("communityHandover maps the owner refusal to FORBIDDEN", async () => {
    vi.spyOn(entityPageUseCases, "getCommunityHandover").mockRejectedValue(
      new AppError("NOT_RESOURCE_OWNER", { meta: { entity: "place" } }),
    );
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.communityHandover({ placeId: PLACE_UUID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("communityHandover returns the pending notice", async () => {
    const answer = {
      placeId: PLACE_UUID,
      pageId: "page-1",
      pending: {
        sinceHandoverAt: null,
        firstUpdatedAt: "2026-10-14T10:00:00.000Z",
        lastUpdatedAt: "2026-10-14T10:00:00.000Z",
        writers: [
          {
            humanId: "human-mo",
            name: "Mo",
            updateCount: 1,
            firstUpdatedAt: "2026-10-14T10:00:00.000Z",
            lastUpdatedAt: "2026-10-14T10:00:00.000Z",
          },
        ],
        updates: [
          {
            humanId: "human-mo",
            name: "Mo",
            op: "updatePage",
            fields: ["bio"],
            at: "2026-10-14T10:00:00.000Z",
          },
        ],
        truncated: false,
      },
    };
    const spy = vi
      .spyOn(entityPageUseCases, "getCommunityHandover")
      .mockResolvedValue(answer);
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.communityHandover({ placeId: PLACE_UUID }),
    ).resolves.toEqual(answer);
    expect(spy).toHaveBeenCalledWith(expect.anything(), {
      placeId: PLACE_UUID,
      actorHumanId: ACTOR_ID,
    });
  });

  it("resolveCommunityHandover passes the choice, actor and storage base URL", async () => {
    const spy = vi
      .spyOn(resolveCommunityHandoverModule, "resolveCommunityHandover")
      .mockResolvedValue({
        outcome: "cleared",
        pageId: "page-1",
        imagesQueuedForDeletion: 2,
      });
    const { caller, ctx } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    // The base test ctx has no storage URL; the procedure reads it per call.
    (ctx as { storagePublicBaseUrl?: string | null }).storagePublicBaseUrl =
      "https://cdn.test";
    await expect(
      caller.resolveCommunityHandover({ placeId: PLACE_UUID, choice: "clear" }),
    ).resolves.toEqual({
      outcome: "cleared",
      pageId: "page-1",
      imagesQueuedForDeletion: 2,
    });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ storagePublicBaseUrl: "https://cdn.test" }),
      { placeId: PLACE_UUID, choice: "clear", actorHumanId: ACTOR_ID },
    );
  });

  it("resolveCommunityHandover refuses an unknown choice before the use case", async () => {
    const spy = vi.spyOn(
      resolveCommunityHandoverModule,
      "resolveCommunityHandover",
    );
    const { caller } = createEntityPagesCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.resolveCommunityHandover({
        placeId: PLACE_UUID,
        choice: "delete",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["placePageEditAccess", "communityHandover"] as const)(
    "%s requires a session",
    async (procedure) => {
      const { caller } = createEntityPagesCaller({ actorHumanId: null });
      await expect(
        caller[procedure]({ placeId: PLACE_UUID }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );
});
