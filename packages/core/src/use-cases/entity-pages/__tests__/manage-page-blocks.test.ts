import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";

import { managePageBlocks } from "../manage-page-blocks";
import type { ManagePageBlocksDeps } from "../manage-page-blocks";

// ── Helpers ────────────────────────────────────────────────────────────────

const ACTOR_ID = "human-1";

const EXISTING_PAGE = {
  id: "page-1",
  ownerType: "HUMAN" as const,
  ownerId: ACTOR_ID,
  slug: "alice",
  displayName: "Alice",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC" as const,
  createdAt: new Date("2025-06-01"),
  updatedAt: new Date("2025-06-01"),
};

const BLOCK_A = {
  id: "b1",
  pageId: "page-1",
  kind: "about",
  orderIndex: 0,
  data: {},
  visible: true,
};

const BLOCK_B = {
  id: "b2",
  pageId: "page-1",
  kind: "links",
  orderIndex: 1,
  data: {},
  visible: true,
};

function makeDeps(
  overrides?: Partial<{
    entityPages: Record<string, any>;
    canManagePlaceResult: { allowed: boolean };
  }>,
): ManagePageBlocksDeps {
  return {
    repos: {
      entityPages: {
        getByOwner: vi.fn(async () => EXISTING_PAGE),
        listBlocks: vi.fn(async () => [BLOCK_A, BLOCK_B]),
        createBlock: vi.fn(async (data: any) => ({
          id: "b-new",
          pageId: data.pageId,
          kind: data.kind,
          orderIndex: 99,
          data: data.data ?? {},
          visible: data.visible ?? true,
        })),
        updateBlock: vi.fn(async (data: any) => ({
          ...BLOCK_A,
          ...data,
        })),
        reorderBlocks: vi.fn(async () => {}),
        deleteBlock: vi.fn(async () => {}),
        ...overrides?.entityPages,
      },
      authz: {},
    } as any,
    authz: {
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(async () => {}),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(
        async () => overrides?.canManagePlaceResult ?? { allowed: true },
      ),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    },
    // These cases send no image URLs (manage-page-blocks-image-urls.test.ts).
    storagePublicBaseUrl: null,
  } as ManagePageBlocksDeps;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("managePageBlocks", () => {
  // ── add ──────────────────────────────────────────────────────────────────

  describe("add action", () => {
    it("creates a new block with a valid kind", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "about", data: { text: "hi" } },
      });

      expect(result.block).not.toBeNull();
      expect(result.block!.kind).toBe("about");
      expect(result.blocks).toHaveLength(2); // listBlocks mock returns 2
    });

    it("uses registry default data when adding a block without data", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "links" },
      });

      expect(deps.repos.entityPages.createBlock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { links: [] } }),
      );
    });

    it("rejects unsafe link URLs in block data", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "add",
            kind: "links",
            data: { links: [{ label: "Bad", url: "javascript:alert(1)" }] },
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_DATA" });
      expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();
    });

    it("rejects non-object block data", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "about", data: "nope" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_DATA" });
      expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();
    });

    it("rejects an invalid kind for the owner type", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "org_team_roster" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
    });

    it("rejects custom HTML blocks", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "add",
            kind: "custom_html_sanitized",
            data: { html: '<img src=x onerror="alert(1)">' },
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
    });

    it("error message includes valid kinds list", async () => {
      const deps = makeDeps();

      try {
        await managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "org_team_roster" },
        });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("INVALID_BLOCK_KIND");
        expect(err.message).toContain("org_team_roster");
        expect(err.message).toContain("about"); // 'about' is a universal kind that should be listed
      }
    });
  });

  // ── edit ─────────────────────────────────────────────────────────────────

  // booking-review-data-weave FR-004 anti-spoofing: a PLACE page owner can
  // never persist fake venue_stats content — the data schema strips every key
  // except `heading` at the managePageBlocks boundary, and get-public-page
  // rebuilds the content server-side regardless.
  describe("venue_stats anti-spoofing (weave FR-004)", () => {
    const FORGED_DATA = {
      heading: "Numbers",
      dataSource: "venue_stats",
      snapshot: {
        version: 1,
        headline: { reviewCountBand: "50+", wouldPlayAgainPct: 100 },
      },
      snapshotAt: "2026-01-01T00:00:00.000Z",
    };

    it("strips forged snapshot content on add — only heading persists", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
        blockAction: { action: "add", kind: "venue_stats", data: FORGED_DATA },
      });

      expect(deps.repos.entityPages.createBlock).toHaveBeenCalledWith(
        expect.objectContaining({ data: { heading: "Numbers" } }),
      );
    });

    it("strips forged snapshot content on edit — only heading persists", async () => {
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [
            { ...BLOCK_A, kind: "venue_stats", data: {} },
          ]),
        },
      });

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "PLACE",
        ownerId: "place-1",
        blockAction: { action: "edit", blockId: "b1", data: FORGED_DATA },
      });

      expect(deps.repos.entityPages.updateBlock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "b1", data: { heading: "Numbers" } }),
      );
    });

    it("rejects adding venue_stats to a non-PLACE page", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "venue_stats" },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
    });
  });

  describe("edit action", () => {
    it("updates block data", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: {
          action: "edit",
          blockId: "b1",
          data: { content: "updated" },
        },
      });

      expect(result.block).not.toBeNull();
      expect(deps.repos.entityPages.updateBlock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "b1", data: { content: "updated" } }),
      );
    });

    it("validates kind when changing kind on edit", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "edit",
            blockId: "b1",
            kind: "place_hours",
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
    });

    it("rejects data-only edits for legacy invalid block kinds", async () => {
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [
            {
              ...BLOCK_A,
              kind: "custom_html_sanitized",
              data: { html: "<p>legacy</p>" },
            },
          ]),
        },
      });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "edit",
            blockId: "b1",
            data: { html: '<script>alert("xss")</script>' },
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
    });

    it("throws not_found when editing a block outside the page", async () => {
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => []),
        },
      });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "edit",
            blockId: "missing",
            data: { text: "updated" },
          },
        }),
      ).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
    });

    it("allows changing kind to another valid kind", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: {
          action: "edit",
          blockId: "b1",
          kind: "links",
        },
      });

      expect(result.block).not.toBeNull();
    });

    it("resets data to defaults when changing block kind without replacement data", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: {
          action: "edit",
          blockId: "b1",
          kind: "links",
        },
      });

      expect(deps.repos.entityPages.updateBlock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "b1",
          kind: "links",
          data: { links: [] },
        }),
      );
    });

    it("rejects unsafe edited video URLs", async () => {
      const deps = makeDeps({
        entityPages: {
          listBlocks: vi.fn(async () => [{ ...BLOCK_A, kind: "video" }]),
        },
      });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "edit",
            blockId: "b1",
            data: {
              videos: [{ url: "data:text/html,<script>alert(1)</script>" }],
            },
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_DATA" });
      expect(deps.repos.entityPages.updateBlock).not.toHaveBeenCalled();
    });
  });

  // ── reorder ──────────────────────────────────────────────────────────────

  describe("reorder action", () => {
    it("reorders blocks and returns null for affected block", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: {
          action: "reorder",
          orderedBlockIds: ["b2", "b1"],
        },
      });

      expect(result.block).toBeNull();
      expect(deps.repos.entityPages.reorderBlocks).toHaveBeenCalledWith(
        "page-1",
        ["b2", "b1"],
      );
    });

    it("throws not_found when reordering blocks outside the page", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "reorder",
            orderedBlockIds: ["b2", "other-page-block"],
          },
        }),
      ).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
      expect(deps.repos.entityPages.reorderBlocks).not.toHaveBeenCalled();
    });

    it("throws invalid_input when reordering with duplicate block ids", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "reorder",
            orderedBlockIds: ["b1", "b1"],
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_ORDER" });
      expect(deps.repos.entityPages.reorderBlocks).not.toHaveBeenCalled();
    });

    it("throws invalid_input when reordering with an incomplete block list", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: {
            action: "reorder",
            orderedBlockIds: ["b1"],
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_BLOCK_ORDER" });
      expect(deps.repos.entityPages.reorderBlocks).not.toHaveBeenCalled();
    });
  });

  // ── toggleVisibility ─────────────────────────────────────────────────────

  describe("toggleVisibility action", () => {
    it("flips a visible block to hidden", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: {
          action: "toggleVisibility",
          blockId: "b1",
        },
      });

      expect(deps.repos.entityPages.updateBlock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "b1", visible: false }),
      );
    });

    it("throws not_found for unknown block", async () => {
      const deps = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => EXISTING_PAGE),
          listBlocks: vi.fn(async () => []), // no blocks
          createBlock: vi.fn(),
          updateBlock: vi.fn(),
          reorderBlocks: vi.fn(),
          deleteBlock: vi.fn(),
        },
      });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "toggleVisibility", blockId: "nope" },
        }),
      ).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe("delete action", () => {
    it("deletes a block and returns null for affected block", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "delete", blockId: "b1" },
      });

      expect(result.block).toBeNull();
      expect(deps.repos.entityPages.deleteBlock).toHaveBeenCalledWith("b1");
    });

    it("throws not_found when deleting a block outside the page", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "delete", blockId: "other-page-block" },
        }),
      ).rejects.toMatchObject({ code: "BLOCK_NOT_FOUND" });
      expect(deps.repos.entityPages.deleteBlock).not.toHaveBeenCalled();
    });
  });

  // ── auth ─────────────────────────────────────────────────────────────────

  describe("auth", () => {
    it("authorizes ORGANIZATION page edits with the resolved domain actor human id", async () => {
      const orgPage = {
        ...EXISTING_PAGE,
        ownerType: "ORGANIZATION" as const,
        ownerId: "org-1",
      };
      const deps = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => orgPage),
        },
      });

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "ORGANIZATION",
        ownerId: "org-1",
        blockAction: { action: "add", kind: "about" },
      });

      expect(deps.authz.requireOrgRole).toHaveBeenCalledWith(
        expect.objectContaining({
          actorHumanId: ACTOR_ID,
          orgId: "org-1",
        }),
      );
    });

    it("throws forbidden for a different human", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: "other-human",
          blockAction: { action: "add", kind: "about" },
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    });

    it("throws not_found when page does not exist", async () => {
      const deps = makeDeps({
        entityPages: {
          getByOwner: vi.fn(async () => null),
          listBlocks: vi.fn(async () => []),
          createBlock: vi.fn(),
          updateBlock: vi.fn(),
          reorderBlocks: vi.fn(),
          deleteBlock: vi.fn(),
        },
      });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "about" },
        }),
      ).rejects.toMatchObject({ code: "PAGE_NOT_FOUND" });
    });

    it("throws forbidden when PLACE access is denied", async () => {
      const deps = makeDeps({ canManagePlaceResult: { allowed: false } });

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "PLACE",
          ownerId: "place-1",
          blockAction: { action: "add", kind: "about" },
        }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

      expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();
    });
  });

  describe("block sections (recurring-memberships)", () => {
    it("passes a valid section through to createBlock", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "about", section: "memberships" },
      });

      expect(deps.repos.entityPages.createBlock).toHaveBeenCalledWith(
        expect.objectContaining({ section: "memberships" }),
      );
    });

    it("omits section entirely when not provided (adapter/DB default owns it)", async () => {
      const deps = makeDeps();

      await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "about" },
      });

      const call = (deps.repos.entityPages.createBlock as any).mock.calls[0][0];
      expect("section" in call).toBe(false);
    });

    it("rejects an unknown section value", async () => {
      const deps = makeDeps();

      await expect(
        managePageBlocks(deps, {
          actorHumanId: ACTOR_ID,
          ownerType: "HUMAN",
          ownerId: ACTOR_ID,
          blockAction: { action: "add", kind: "about", section: "vip-lounge" },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });

      expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();
    });

    it("defaults legacy records without a section to \"main\" in the output", async () => {
      const deps = makeDeps();

      const result = await managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "about" },
      });

      // BLOCK_A / BLOCK_B fixtures predate `section`; the output schema must
      // fill "main" so every existing page renders identically.
      expect(result.blocks.map((b) => b.section)).toEqual(["main", "main"]);
    });
  });
});

// ── pinned blocks (venue-track-record-and-review-switch R6 / FR-012) ────────

describe("managePageBlocks — pinned track_record", () => {
  const PLACE_PAGE = {
    ...EXISTING_PAGE,
    id: "page-p",
    ownerType: "PLACE" as const,
    ownerId: "place-1",
    slug: "the-roxy",
  };
  const TRACK_RECORD = {
    id: "tr",
    pageId: "page-p",
    kind: "track_record",
    orderIndex: 0,
    data: { heading: "What's happened here" },
    visible: true,
  };
  const VENUE_STATS = {
    id: "vs",
    pageId: "page-p",
    kind: "venue_stats",
    orderIndex: 1,
    data: {},
    visible: true,
  };

  function makePlaceDeps(blocks: unknown[] = [TRACK_RECORD, VENUE_STATS]) {
    return makeDeps({
      entityPages: {
        getByOwner: vi.fn(async () => PLACE_PAGE),
        listBlocks: vi.fn(async () => blocks),
      },
    });
  }

  const asOwner = (blockAction: unknown) => ({
    actorHumanId: ACTOR_ID,
    ownerType: "PLACE" as const,
    ownerId: "place-1",
    blockAction,
  });

  it("delete → BLOCK_PINNED, and the repo delete is never called", async () => {
    const deps = makePlaceDeps();

    await expect(
      managePageBlocks(deps, asOwner({ action: "delete", blockId: "tr" })),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "delete" },
    });

    expect(deps.repos.entityPages.deleteBlock).not.toHaveBeenCalled();
  });

  it("deleting the unpinned venue_stats sibling on the same page still works", async () => {
    const deps = makePlaceDeps();

    const result = await managePageBlocks(
      deps,
      asOwner({ action: "delete", blockId: "vs" }),
    );

    expect(result.block).toBeNull();
    expect(deps.repos.entityPages.deleteBlock).toHaveBeenCalledWith("vs");
  });

  it("reorder that moves the pinned block succeeds (reorderable, not removable)", async () => {
    const deps = makePlaceDeps();

    await managePageBlocks(
      deps,
      asOwner({ action: "reorder", orderedBlockIds: ["vs", "tr"] }),
    );

    expect(deps.repos.entityPages.reorderBlocks).toHaveBeenCalledWith(
      "page-p",
      ["vs", "tr"],
    );
  });

  it("toggleVisibility → BLOCK_PINNED (hiding is removal from the public page)", async () => {
    const deps = makePlaceDeps();

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "toggleVisibility", blockId: "tr" }),
      ),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "hide" },
    });
    expect(deps.repos.entityPages.updateBlock).not.toHaveBeenCalled();
  });

  it("edit with visible:false → BLOCK_PINNED; editing only the heading is fine", async () => {
    const deps = makePlaceDeps();

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "edit", blockId: "tr", visible: false }),
      ),
    ).rejects.toMatchObject({ code: "BLOCK_PINNED" });
    expect(deps.repos.entityPages.updateBlock).not.toHaveBeenCalled();

    await managePageBlocks(
      deps,
      asOwner({
        action: "edit",
        blockId: "tr",
        data: { heading: "The door", showsHosted: 999 },
      }),
    );
    // Heading persists; the forged figure is stripped by the schema.
    expect(deps.repos.entityPages.updateBlock).toHaveBeenCalledWith({
      id: "tr",
      data: { heading: "The door" },
    });
  });

  it("edit that re-kinds the pinned block away → BLOCK_PINNED", async () => {
    const deps = makePlaceDeps();

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "edit", blockId: "tr", kind: "about" }),
      ),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "change_kind" },
    });
    expect(deps.repos.entityPages.updateBlock).not.toHaveBeenCalled();
  });

  it("edit that re-kinds ANOTHER block into track_record → BLOCK_PINNED (a second undeletable copy)", async () => {
    const deps = makePlaceDeps();

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "edit", blockId: "vs", kind: "track_record" }),
      ),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_duplicate" },
    });
    expect(deps.repos.entityPages.updateBlock).not.toHaveBeenCalled();
  });

  it("add when the page already has one → BLOCK_PINNED; add when absent is the recovery path", async () => {
    const withIt = makePlaceDeps();
    await expect(
      managePageBlocks(withIt, asOwner({ action: "add", kind: "track_record" })),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_duplicate" },
    });
    expect(withIt.repos.entityPages.createBlock).not.toHaveBeenCalled();

    const without = makePlaceDeps([VENUE_STATS]);
    const result = await managePageBlocks(
      without,
      asOwner({ action: "add", kind: "track_record" }),
    );
    expect(result.block?.kind).toBe("track_record");
    expect(without.repos.entityPages.createBlock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "track_record", visible: true }),
    );
  });

  it("add into a NON-MAIN section → BLOCK_PINNED add_sectioned (the public page never renders it; edit cannot move it)", async () => {
    const deps = makePlaceDeps([VENUE_STATS]);

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "add", kind: "track_record", section: "memberships" }),
      ),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_sectioned" },
    });
    expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();

    // An explicit "main" is the same as omitting it.
    await managePageBlocks(
      deps,
      asOwner({ action: "add", kind: "track_record", section: "main" }),
    );
    expect(deps.repos.entityPages.createBlock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "track_record", section: "main" }),
    );
  });

  it("a stray non-main copy never counts as present — the add reaches the repo, where the section-blind partial unique index REFUSES it as BLOCK_PINNED add_duplicate (never silently accepted)", async () => {
    const stray = { ...TRACK_RECORD, id: "stray", section: "memberships" };
    const deps = makePlaceDeps([stray, VENUE_STATS]);
    // Emulate the adapter against the real index
    // ("PageBlock_pinned_kind_per_page_key", migration 20260924140000): the
    // insert collides with the stray and the adapter maps the P2002.
    deps.repos.entityPages.createBlock = vi.fn(async () => {
      throw fail("BLOCK_PINNED", {
        meta: { kind: "track_record", attempted: "add_duplicate" },
      });
    }) as any;

    await expect(
      managePageBlocks(deps, asOwner({ action: "add", kind: "track_record" })),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_duplicate" },
    });
    // The core check did NOT treat the stray as present (the insert was
    // attempted); the refusal came from the index, not from a quiet skip.
    expect(deps.repos.entityPages.createBlock).toHaveBeenCalledTimes(1);
  });

  it("add with visible:false → BLOCK_PINNED (never seeded hidden)", async () => {
    const deps = makePlaceDeps([VENUE_STATS]);

    await expect(
      managePageBlocks(
        deps,
        asOwner({ action: "add", kind: "track_record", visible: false }),
      ),
    ).rejects.toMatchObject({
      code: "BLOCK_PINNED",
      meta: { kind: "track_record", attempted: "add_hidden" },
    });
    expect(deps.repos.entityPages.createBlock).not.toHaveBeenCalled();
  });

  it("stays a PLACE-only kind: adding it to a HUMAN page is INVALID_BLOCK_KIND, not BLOCK_PINNED", async () => {
    const deps = makeDeps();

    await expect(
      managePageBlocks(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: ACTOR_ID,
        blockAction: { action: "add", kind: "track_record" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_BLOCK_KIND" });
  });
});
