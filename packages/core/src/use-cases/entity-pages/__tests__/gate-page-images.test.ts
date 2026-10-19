/**
 * The public page image review gate (moderator place page spec R5):
 * a page image whose moderation record is not APPROVED is absent from the
 * public payload; an approved image and an image with no record (an owner
 * upload, a legacy one) stay. One batched lookup per page.
 */

import { describe, expect, it, vi } from "vitest";

import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { gatePublicPageImages } from "../gate-page-images";

const CDN = "https://cdn.example";
const PREFIX = "entity-pages/place/place-1/2026-10-16/";
const key = (hex: string) => `${PREFIX}${hex.repeat(32)}.jpg`;
const url = (k: string) => `${CDN}/${k}`;

const APPROVED = key("a");
const PENDING = key("b");
const FLAGGED = key("c");
const REJECTED = key("d");
const OWNER_UPLOAD = key("e"); // no record
const ORPHANED = key("f");

function repos(statuses: Record<string, ImageModerationRecord["status"]>) {
  const resolveByKeys = vi.fn(async (keys: string[]) => {
    const found = new Map<string, Pick<ImageModerationRecord, "status">>();
    for (const k of keys) {
      const status = statuses[k];
      if (status) found.set(k, { status });
    }
    return found;
  });
  return {
    repo: {
      imageModerationRecords: { resolveByKeys },
    } as unknown as Parameters<typeof gatePublicPageImages>[0],
    resolveByKeys,
  };
}

const STATUSES = {
  [APPROVED]: "APPROVED",
  [PENDING]: "PENDING",
  [FLAGGED]: "FLAGGED",
  [REJECTED]: "REJECTED",
  [ORPHANED]: "ORPHANED",
} as const;

const PAGE = {
  id: "page-1",
  ownerType: "PLACE" as const,
  ownerId: "place-1",
  avatarUrl: url(PENDING),
  bannerUrl: url(APPROVED),
};

describe("gatePublicPageImages", () => {
  it("hides PENDING / FLAGGED / REJECTED / ORPHANED images and keeps APPROVED and record-less ones, in ONE lookup", async () => {
    const { repo, resolveByKeys } = repos(STATUSES);
    const blocks = [
      {
        id: "photos",
        kind: "photos",
        data: {
          heading: "Inside",
          photos: [
            { url: url(APPROVED), alt: "bar" },
            { url: url(FLAGGED), alt: "stage" },
            { url: url(OWNER_UPLOAD), alt: "door" },
            { url: url(REJECTED) },
            { url: url(ORPHANED) },
          ],
        },
      },
      { id: "plain", kind: "about", data: { content: "<p>No images</p>" } },
    ];

    const gated = await gatePublicPageImages(repo, PAGE, blocks);

    expect(resolveByKeys).toHaveBeenCalledTimes(1);
    expect(new Set(resolveByKeys.mock.calls[0]![0])).toEqual(
      new Set([PENDING, APPROVED, FLAGGED, OWNER_UPLOAD, REJECTED, ORPHANED]),
    );
    // Absent, not a broken URL.
    expect(gated.page.avatarUrl).toBeNull();
    expect(gated.page.bannerUrl).toBe(url(APPROVED));
    expect(gated.page.id).toBe("page-1");
    expect(gated.blocks).toEqual([
      {
        id: "photos",
        kind: "photos",
        data: {
          heading: "Inside",
          photos: [
            { url: url(APPROVED), alt: "bar" },
            { url: url(OWNER_UPLOAD), alt: "door" },
          ],
        },
      },
      { id: "plain", kind: "about", data: { content: "<p>No images</p>" } },
    ]);
    // The input is not mutated.
    expect(blocks[0]!.data.photos).toHaveLength(5);
  });

  it("omits a block that still names a hidden image outside an image field (rich text <img>)", async () => {
    const { repo } = repos(STATUSES);
    const gated = await gatePublicPageImages(
      repo,
      { ...PAGE, avatarUrl: null, bannerUrl: null },
      [
        {
          id: "about",
          kind: "about",
          data: { content: `<p>Hi</p><img src="${url(PENDING)}">` },
        },
        {
          id: "about-ok",
          kind: "about",
          data: { content: `<img src="${url(APPROVED)}">` },
        },
      ],
    );
    expect(gated.blocks.map((b) => b.id)).toEqual(["about-ok"]);
  });

  it("makes no lookup for a page that names no uploaded image", async () => {
    const { repo, resolveByKeys } = repos(STATUSES);
    const page = {
      ...PAGE,
      avatarUrl: "https://elsewhere.example/a.jpg",
      bannerUrl: null,
    };
    const blocks = [{ id: "about", kind: "about", data: { content: "x" } }];
    const gated = await gatePublicPageImages(repo, page, blocks);
    expect(resolveByKeys).not.toHaveBeenCalled();
    expect(gated.page).toBe(page);
    expect(gated.blocks).toEqual(blocks);
  });

  it("makes no lookup for a HUMAN or ORGANIZATION page (only place pages hold reviewed images)", async () => {
    for (const ownerType of ["HUMAN", "ORGANIZATION"] as const) {
      const { repo, resolveByKeys } = repos({
        [`entity-pages/${ownerType.toLowerCase()}/owner-1/2026-10-16/${"b".repeat(32)}.jpg`]:
          "PENDING",
      });
      const avatar = `${CDN}/entity-pages/${ownerType.toLowerCase()}/owner-1/2026-10-16/${"b".repeat(32)}.jpg`;
      const page = { ...PAGE, ownerType, ownerId: "owner-1", avatarUrl: avatar };
      const gated = await gatePublicPageImages(repo, page, []);
      expect(resolveByKeys).not.toHaveBeenCalled();
      expect(gated.page).toBe(page);
    }
  });

  it("ignores another page's keys: only the page's own prefix is gated", async () => {
    const { repo, resolveByKeys } = repos({
      ["entity-pages/place/other/2026-10-16/" + "b".repeat(32) + ".jpg"]: "PENDING",
    });
    const foreign = `${CDN}/entity-pages/place/other/2026-10-16/${"b".repeat(32)}.jpg`;
    const gated = await gatePublicPageImages(
      repo,
      { ...PAGE, avatarUrl: foreign, bannerUrl: null },
      [],
    );
    expect(resolveByKeys).not.toHaveBeenCalled();
    expect(gated.page.avatarUrl).toBe(foreign);
  });

  it("fails closed by throwing when the lookup fails (no fallback that could show a pending image)", async () => {
    const repo = {
      imageModerationRecords: {
        resolveByKeys: vi.fn(async () => {
          throw new Error("db down");
        }),
      },
    } as unknown as Parameters<typeof gatePublicPageImages>[0];
    await expect(gatePublicPageImages(repo, PAGE, [])).rejects.toThrow(
      "db down",
    );
  });
});
