/**
 * The follows list shows a followed PLACE page's avatar only when the image
 * review allows it (moderator place page spec R5): a community moderator's
 * upload that is still PENDING (or FLAGGED / REJECTED) is left out, as on the
 * public page. One batched lookup for the whole list.
 */

import { describe, expect, it, vi } from "vitest";

import {
  listFollowedEntities,
  type ListFollowedEntitiesDeps,
} from "../list-followed-entities";

const CDN = "https://cdn.example";
const placeKey = (placeId: string, hex: string) =>
  `entity-pages/place/${placeId}/2026-10-16/${hex.repeat(32)}.jpg`;

function follow(
  id: string,
  page: { ownerType: string; ownerId: string; avatarUrl: string | null },
) {
  return {
    id: `follow-${id}`,
    followerHumanId: "viewer",
    entityPageId: `page-${id}`,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    notifyNewEvents: true,
    notifyNearby: false,
    radiusKm: null,
    entityPage: { id: `page-${id}`, slug: `slug-${id}`, displayName: id, ...page },
  };
}

function deps(items: unknown[], statuses: Record<string, string>) {
  const resolveByKeys = vi.fn(async (keys: string[]) => {
    const found = new Map<string, { status: string }>();
    for (const key of keys) {
      if (statuses[key]) found.set(key, { status: statuses[key]! });
    }
    return found;
  });
  return {
    deps: {
      repos: {
        follows: {
          listByFollower: vi.fn(async () => ({ items, nextCursor: null })),
        },
        places: { getByIds: vi.fn(async () => new Map()) },
        imageModerationRecords: { resolveByKeys },
      },
    } as unknown as ListFollowedEntitiesDeps,
    resolveByKeys,
  };
}

describe("listFollowedEntities: place avatars pass the image review", () => {
  it("drops a pending place avatar, keeps approved and record-less ones, in ONE lookup", async () => {
    const pending = placeKey("place-1", "a");
    const approved = placeKey("place-2", "b");
    const ownerUpload = placeKey("place-3", "c");
    const { deps: d, resolveByKeys } = deps(
      [
        follow("1", { ownerType: "PLACE", ownerId: "place-1", avatarUrl: `${CDN}/${pending}` }),
        follow("2", { ownerType: "PLACE", ownerId: "place-2", avatarUrl: `${CDN}/${approved}` }),
        follow("3", { ownerType: "PLACE", ownerId: "place-3", avatarUrl: `${CDN}/${ownerUpload}` }),
      ],
      { [pending]: "PENDING", [approved]: "APPROVED" },
    );
    const result = await listFollowedEntities(d, { actorHumanId: "viewer" });
    expect(result.items.map((i) => i.avatarUrl)).toEqual([
      null,
      `${CDN}/${approved}`,
      `${CDN}/${ownerUpload}`,
    ]);
    expect(resolveByKeys).toHaveBeenCalledOnce();
    expect(resolveByKeys).toHaveBeenCalledWith(
      expect.arrayContaining([pending, approved, ownerUpload]),
    );
  });

  it("makes no lookup when no place avatar is an upload (outside URLs, other owners, no avatar)", async () => {
    const { deps: d, resolveByKeys } = deps(
      [
        follow("1", { ownerType: "PLACE", ownerId: "place-1", avatarUrl: "https://elsewhere.example/a.jpg" }),
        follow("2", { ownerType: "PLACE", ownerId: "place-2", avatarUrl: null }),
        follow("3", {
          ownerType: "ORGANIZATION",
          ownerId: "org-1",
          avatarUrl: `${CDN}/entity-pages/organization/org-1/2026-10-16/${"d".repeat(32)}.jpg`,
        }),
      ],
      {},
    );
    const result = await listFollowedEntities(d, { actorHumanId: "viewer" });
    expect(resolveByKeys).not.toHaveBeenCalled();
    expect(result.items.map((i) => i.avatarUrl)).toEqual([
      "https://elsewhere.example/a.jpg",
      null,
      `${CDN}/entity-pages/organization/org-1/2026-10-16/${"d".repeat(32)}.jpg`,
    ]);
  });
});
