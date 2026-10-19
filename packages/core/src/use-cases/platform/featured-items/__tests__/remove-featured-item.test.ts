import { describe, expect, it, vi } from "vitest";

import { removeFeaturedItem } from "../remove-featured-item";
import type { RemoveFeaturedItemDeps } from "../remove-featured-item";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-12T12:00:00Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

function buildDeps(
  overrides: { allowed?: boolean } = {},
): RemoveFeaturedItemDeps {
  const allowed = overrides.allowed ?? true;

  const featuredItems = {
    remove: vi.fn(async () => {}),
  };
  const audit = {
    log: vi.fn(),
  };

  return {
    repos: {
      featuredItems,
      audit,
      tx: vi.fn(async (fn: any) => fn({ featuredItems, audit })),
    } as unknown as RemoveFeaturedItemDeps["repos"],
    authz: {
      hasStaffRole: vi.fn(async () => ({ allowed })),
    } as unknown as RemoveFeaturedItemDeps["authz"],
    clock: { now: () => NOW },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("removeFeaturedItem", () => {
  it("removes a featured item (happy path)", async () => {
    const deps = buildDeps();

    const result = await removeFeaturedItem(deps, {
      actorHumanId: ACTOR_ID,
      itemType: "EVENT",
      itemId: ITEM_ID,
    });

    expect(result).toEqual({ success: true });
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect((deps.repos as any).featuredItems.remove).toHaveBeenCalledWith({
      itemType: "EVENT",
      itemId: ITEM_ID,
    });
    expect((deps.repos as any).audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "FeaturedItem",
        action: "featured_item.remove",
      }),
    );
  });

  it("throws forbidden for non-staff actors", async () => {
    const deps = buildDeps({ allowed: false });

    await expect(
      removeFeaturedItem(deps, {
        actorHumanId: ACTOR_ID,
        itemType: "EVENT",
        itemId: ITEM_ID,
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("succeeds silently when removing a non-existent item", async () => {
    const deps = buildDeps();

    const result = await removeFeaturedItem(deps, {
      actorHumanId: ACTOR_ID,
      itemType: "PLACE",
      itemId: ITEM_ID,
    });

    expect(result).toEqual({ success: true });
  });
});
