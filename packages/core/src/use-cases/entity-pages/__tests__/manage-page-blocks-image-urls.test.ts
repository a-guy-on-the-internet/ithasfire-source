/**
 * managePageBlocks' block image-URL rule (`assertBlockImageUrlsAllowed`),
 * for a COMMUNITY MODERATOR only: a NEW image URL in block data must be this
 * page's own metadata-stripped upload, or already be live on one of the
 * page's blocks. Without it, a moderator could put an outside image (or a
 * raw upload that still carries EXIF/GPS) on a place page and skip both the
 * strip and the image review (moderator place page spec R5, D10). An owner
 * is not checked: the owner's editor takes a typed photo URL and undo
 * re-adds a deleted block's snapshot, and owner uploads are not reviewed.
 */

import { describe, expect, it } from "vitest";

import { managePageBlocks } from "../manage-page-blocks";
import {
  CDN,
  HUMAN_A,
  PLACE_ID,
  block,
  liveBlocks,
  makeHarness,
  ownedImage,
  ownerInput,
  rawUploadImage,
  type Harness,
} from "./page-draft-harness";

const MODERATOR = "human-moderator";

function deps(h: Harness, storagePublicBaseUrl: string | null = CDN) {
  return {
    repos: h.repos,
    authz: h.authz,
    clock: h.clock,
    logger: h.logger,
    storagePublicBaseUrl,
  };
}

function ownerHarness(): Harness {
  return makeHarness();
}

/** A place nobody owns, edited by a community moderator. */
function unownedHarness(): Harness {
  const h = makeHarness({ moderators: [MODERATOR] });
  h.setPlace({
    orgIdsWithAccess: [],
    humanIdsWithAccess: [],
    verificationStatus: "UNVERIFIED",
  });
  return h;
}

function addPhoto(h: Harness, actor: string, url: string, base?: string | null) {
  return managePageBlocks(deps(h, base) as never, {
    ...ownerInput(actor),
    blockAction: {
      action: "add",
      kind: "photos",
      data: { photos: [{ url }] },
    },
  });
}

const REFUSED = {
  code: "INVALID_BLOCK_DATA",
  meta: { kind: "photos", reason: "image_url_not_allowed" },
};

describe("managePageBlocks block image URLs", () => {
  describe("refused", () => {
    it("a moderator's outside https URL", async () => {
      const h = unownedHarness();
      await expect(
        addPhoto(h, MODERATOR, "https://elsewhere.example/cat.jpg"),
      ).rejects.toMatchObject(REFUSED);
      expect(h.blocks()).toHaveLength(liveBlocks().length);
    });

    it("a raw (unstripped) upload key under the page's own prefix", async () => {
      const h = unownedHarness();
      await expect(
        addPhoto(h, MODERATOR, rawUploadImage()),
      ).rejects.toMatchObject(REFUSED);
    });

    it("another page's stripped key", async () => {
      const h = unownedHarness();
      await expect(
        addPhoto(h, MODERATOR, ownedImage("theirs", "PLACE", "place-other")),
      ).rejects.toMatchObject(REFUSED);
    });

    it("an edit that swaps in a new outside URL", async () => {
      const h = unownedHarness();
      await expect(
        managePageBlocks(deps(h) as never, {
          ...ownerInput(MODERATOR),
          blockAction: {
            action: "edit",
            blockId: "blk-photos",
            data: {
              photos: [
                { url: ownedImage("live-photo") },
                { url: "https://elsewhere.example/cat.jpg" },
              ],
            },
          },
        }),
      ).rejects.toMatchObject(REFUSED);
      expect(h.blocks().find((b) => b.id === "blk-photos")?.data).toEqual({
        photos: [{ url: ownedImage("live-photo") }],
      });
    });

    it("with no storage public base URL, even the page's own stripped upload", async () => {
      const h = unownedHarness();
      await expect(
        addPhoto(h, MODERATOR, ownedImage("new-photo"), null),
      ).rejects.toMatchObject(REFUSED);
    });
  });

  describe("an owner is not checked", () => {
    it("an owner's outside https URL (the editor's typed photo URL)", async () => {
      const h = ownerHarness();
      await addPhoto(h, HUMAN_A, "https://elsewhere.example/cat.jpg");
      expect(h.blocks().at(-1)?.data).toEqual({
        photos: [{ url: "https://elsewhere.example/cat.jpg" }],
      });
    });

    it("an owner's raw upload key and another page's key", async () => {
      const h = ownerHarness();
      await addPhoto(h, HUMAN_A, rawUploadImage());
      await addPhoto(h, HUMAN_A, ownedImage("theirs", "HUMAN", HUMAN_A));
      expect(h.blocks()).toHaveLength(liveBlocks().length + 2);
    });

    it("an owner's edit to a new outside URL, even with no storage base URL", async () => {
      const h = ownerHarness();
      await managePageBlocks(deps(h, null) as never, {
        ...ownerInput(HUMAN_A),
        blockAction: {
          action: "edit",
          blockId: "blk-photos",
          data: { photos: [{ url: "https://elsewhere.example/cat.jpg" }] },
        },
      });
      expect(h.blocks().find((b) => b.id === "blk-photos")?.data).toEqual({
        photos: [{ url: "https://elsewhere.example/cat.jpg" }],
      });
    });

    it("undo of a deleted photos block with an outside URL re-adds it", async () => {
      const outside = "https://elsewhere.example/cat.jpg";
      const h = makeHarness({
        blocks: [
          ...liveBlocks(),
          block("blk-outside", "photos", 9, { data: { photos: [{ url: outside }] } }),
        ],
      });
      await managePageBlocks(deps(h) as never, {
        ...ownerInput(HUMAN_A),
        blockAction: { action: "delete", blockId: "blk-outside" },
      });
      expect(h.blocks().some((b) => b.id === "blk-outside")).toBe(false);

      // Undo: the editor re-adds the deleted block's snapshot. The URL is no
      // longer live on the page, so a moderator would be refused here.
      await addPhoto(h, HUMAN_A, outside);
      expect(h.blocks().at(-1)?.data).toEqual({ photos: [{ url: outside }] });
    });
  });

  describe("accepted", () => {
    it("the page's own stripped upload, for a moderator and an owner", async () => {
      const h = unownedHarness();
      await addPhoto(h, MODERATOR, ownedImage("new-photo"));
      expect(h.blocks().at(-1)?.data).toEqual({
        photos: [{ url: ownedImage("new-photo") }],
      });

      const owner = ownerHarness();
      await addPhoto(owner, HUMAN_A, ownedImage("new-photo"));
      expect(owner.blocks()).toHaveLength(liveBlocks().length + 1);
    });

    it("a URL already live on another block of the page (even an outside one)", async () => {
      const legacy = "https://legacy.example/old.jpg";
      const h = makeHarness({
        moderators: [MODERATOR],
        blocks: [
          ...liveBlocks(),
          block("blk-legacy", "photos", 9, { data: { photos: [{ url: legacy }] } }),
        ],
      });
      h.setPlace({
        orgIdsWithAccess: [],
        humanIdsWithAccess: [],
        verificationStatus: "UNVERIFIED",
      });
      await addPhoto(h, MODERATOR, legacy);
      expect(h.blocks().at(-1)?.data).toEqual({ photos: [{ url: legacy }] });
    });

    it("an edit that keeps the block's existing images unchanged", async () => {
      const legacy = "https://legacy.example/old.jpg";
      const h = makeHarness({
        blocks: [
          block("blk-legacy", "photos", 0, {
            data: { photos: [{ url: legacy }] },
          }),
        ],
      });
      await managePageBlocks(deps(h, null) as never, {
        ...ownerInput(HUMAN_A),
        blockAction: {
          action: "edit",
          blockId: "blk-legacy",
          data: { photos: [{ url: legacy, caption: "Still here" }] },
        },
      });
      expect(h.blocks()[0]?.data).toMatchObject({
        photos: [{ url: legacy, caption: "Still here" }],
      });
    });

    it("block data with no image field is not checked", async () => {
      const h = ownerHarness();
      await managePageBlocks(deps(h, null) as never, {
        ...ownerInput(HUMAN_A, "PLACE", PLACE_ID),
        blockAction: {
          action: "edit",
          blockId: "blk-amenities",
          data: { amenities: ["Bar", "Stage"] },
        },
      });
      expect(
        h.blocks().find((b) => b.id === "blk-amenities")?.data,
      ).toMatchObject({ amenities: ["Bar", "Stage"] });
    });
  });
});
