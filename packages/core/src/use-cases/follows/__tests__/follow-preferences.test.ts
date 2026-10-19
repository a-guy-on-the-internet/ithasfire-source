import { describe, expect, it, vi } from "vitest";
import { listFollowedEntities } from "../list-followed-entities";
import { updateFollowPreferences, type UpdateFollowPreferencesDeps } from "../update-follow-preferences";
import type { ListFollowedEntitiesDeps } from "../list-followed-entities";

const item = {
  id: "follow-1", followerHumanId: "viewer", entityPageId: "page-1",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  notifyNewEvents: false, notifyNearby: true, radiusKm: 75,
  entityPage: { id: "page-1", slug: "venue", displayName: "Venue", avatarUrl: null, ownerType: "PLACE", ownerId: "place-1" },
};

describe("follow preferences", () => {
  it("returns the viewer's saved preferences and pagination cursor", async () => {
    const listByFollower = vi.fn().mockResolvedValue({ items: [item], nextCursor: "follow-1" });
    const getByIds = vi.fn().mockResolvedValue(new Map([["place-1", { id: "place-1", name: "Venue" }]]));
    const result = await listFollowedEntities({ repos: { follows: { listByFollower }, places: { getByIds } } } as unknown as ListFollowedEntitiesDeps,
      { actorHumanId: "viewer", cursor: "earlier", limit: 20 });
    expect(listByFollower).toHaveBeenCalledWith("viewer", { cursor: "earlier", limit: 20, ownerTypeFilter: undefined });
    expect(result.items[0]).toMatchObject({ notifyNewEvents: false, notifyNearby: true, radiusKm: 75 });
    expect(result.nextCursor).toBe("follow-1");
    expect(result.items[0]).not.toHaveProperty("followerHumanId");
  });

  it("lists a followed place under Place.name, not its frozen page displayName, in one batched read", async () => {
    const org = { ...item, id: "follow-2", entityPageId: "page-2",
      entityPage: { id: "page-2", slug: "org", displayName: "Org Page", avatarUrl: null, ownerType: "ORGANIZATION", ownerId: "org-1" } };
    const place2 = { ...item, id: "follow-3", entityPageId: "page-3",
      entityPage: { id: "page-3", slug: "other-venue", displayName: "Old Name", avatarUrl: null, ownerType: "PLACE", ownerId: "place-1" } };
    const stale = { ...item, entityPage: { ...item.entityPage, displayName: "Frozen Old Name" } };
    const listByFollower = vi.fn().mockResolvedValue({ items: [stale, org, place2], nextCursor: null });
    const getByIds = vi.fn().mockResolvedValue(new Map([["place-1", { id: "place-1", name: "The Real Place" }]]));
    const result = await listFollowedEntities({ repos: { follows: { listByFollower }, places: { getByIds } } } as unknown as ListFollowedEntitiesDeps,
      { actorHumanId: "viewer" });
    expect(result.items.map((i) => i.displayName)).toEqual(["The Real Place", "Org Page", "The Real Place"]);
    expect(getByIds).toHaveBeenCalledOnce();
    expect(getByIds).toHaveBeenCalledWith(["place-1"]);
  });

  it("skips the place read when no followed page is a place", async () => {
    const org = { ...item, entityPage: { id: "page-2", slug: "org", displayName: null, avatarUrl: null, ownerType: "ORGANIZATION", ownerId: "org-1" } };
    const listByFollower = vi.fn().mockResolvedValue({ items: [org], nextCursor: null });
    const getByIds = vi.fn();
    const result = await listFollowedEntities({ repos: { follows: { listByFollower }, places: { getByIds } } } as unknown as ListFollowedEntitiesDeps,
      { actorHumanId: "viewer" });
    expect(result.items[0]?.displayName).toBe("org");
    expect(getByIds).not.toHaveBeenCalled();
  });

  function deps(existing: unknown = item) {
    const updateFollowPreferences = vi.fn().mockResolvedValue(item);
    const tx = { follows: { getFollow: vi.fn().mockResolvedValue(existing), updateFollowPreferences }, audit: { log: vi.fn() } };
    return { input: { repos: { tx: (work: (v: unknown) => unknown) => work(tx) } } as unknown as UpdateFollowPreferencesDeps, tx };
  }

  it("keeps the stored radius when a nearby save omits radiusKm", async () => {
    const d = deps();
    await updateFollowPreferences(d.input, { actorHumanId: "viewer", entityPageId: "page-1", notifyNewEvents: false, notifyNearby: true });
    expect(d.tx.follows.updateFollowPreferences).toHaveBeenCalledWith("viewer", "page-1", { notifyNewEvents: false, notifyNearby: true, radiusKm: 75 });
  });

  it("stores a radius the person sent", async () => {
    const d = deps();
    await updateFollowPreferences(d.input, { actorHumanId: "viewer", entityPageId: "page-1", notifyNewEvents: true, notifyNearby: true, radiusKm: 40 });
    expect(d.tx.follows.updateFollowPreferences).toHaveBeenCalledWith("viewer", "page-1", { notifyNewEvents: true, notifyNearby: true, radiusKm: 40 });
  });

  it("defaults nearby distance to 100km when none is stored and scopes writes to the authenticated human", async () => {
    const d = deps({ ...item, notifyNearby: false, radiusKm: null });
    await updateFollowPreferences(d.input, { actorHumanId: "viewer", entityPageId: "page-1", notifyNewEvents: true, notifyNearby: true });
    expect(d.tx.follows.updateFollowPreferences).toHaveBeenCalledWith("viewer", "page-1", { notifyNewEvents: true, notifyNearby: true, radiusKm: 100 });
    expect(d.tx.audit.log).toHaveBeenCalledOnce();
  });

  it("rejects an absent follow and invalid radius without writing", async () => {
    const d = deps(null);
    await expect(updateFollowPreferences(d.input, { actorHumanId: "viewer", entityPageId: "page-1", notifyNewEvents: true, notifyNearby: false })).rejects.toThrow();
    await expect(updateFollowPreferences(d.input, { actorHumanId: "viewer", entityPageId: "page-1", notifyNewEvents: true, notifyNearby: true, radiusKm: 501 })).rejects.toThrow();
    expect(d.tx.follows.updateFollowPreferences).not.toHaveBeenCalled();
  });
});
