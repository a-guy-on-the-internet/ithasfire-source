import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { entityPagesRouter } from "../entity-pages";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * Every finalize that runs the image metadata strip charges ONE per-actor
 * bucket: entity-page images, avatar, banner and event images. They share a
 * process-wide pool of strip slots, so per-procedure buckets would let one
 * account queue four times the work and make every other user's finalize
 * fail `image_strip_busy` (security review F2, image strip step 2).
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const KEY = `images:finalize:${ACTOR_ID}`;

/** A real per-key counter: allows `max` calls per key, then refuses. */
function countingRateLimit() {
  const counts = new Map<string, number>();
  return {
    counts,
    consume: vi.fn(async (key: string, max: number) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= max
        ? { allowed: true, remaining: max - n, retryAfterSeconds: 0 }
        : { allowed: false, remaining: 0, retryAfterSeconds: 42 };
    }),
  };
}

/** Repos the use cases never reach: every call here fails before them. */
const repos = () =>
  ({
    images: { getById: vi.fn(async () => null) },
    entityPages: { getByOwner: vi.fn(async () => null) },
  }) as unknown as Ctx["repos"];

function callers() {
  const rateLimit = countingRateLimit();
  const ctx = {
    repos: repos(),
    rateLimit: rateLimit as unknown as Ctx["rateLimit"],
    actorHumanId: ACTOR_ID,
  };
  return {
    rateLimit,
    pages: createCaller(entityPagesRouter, ctx).caller,
    events: createCaller(eventsRouter, ctx).caller,
  };
}

// Keys the use cases refuse at once (not this human's / not an upload key),
// so each call charges the bucket and nothing else.
const avatarKey = "avatars/human/someone-else/x.jpg";
const bannerKey = "banners/human/someone-else/x.jpg";
const pageKey = "entity-pages/human/someone-else/x.jpg";

describe("image finalizes share one per-actor rate-limit bucket", () => {
  it("20 avatar finalizes spend the bucket: the next page, banner and event finalizes are refused", async () => {
    const { rateLimit, pages, events } = callers();

    for (let i = 0; i < 20; i++) {
      await expect(pages.setAvatarFromUpload({ key: avatarKey })).rejects.not.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
    }

    await expect(
      pages.finalizeImageUpload({ ownerType: "HUMAN", ownerId: ACTOR_ID, key: pageKey }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(pages.setBannerFromUpload({ key: bannerKey })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    await expect(
      events.finalizeImageUpload({ imageId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(rateLimit.counts.get(KEY)).toBe(23);
  });

  it("each of the four charges the same key, 20 per 60 s", async () => {
    const { rateLimit, pages, events } = callers();

    await pages.finalizeImageUpload({ ownerType: "HUMAN", ownerId: ACTOR_ID, key: pageKey }).catch(
      () => {},
    );
    await pages.setAvatarFromUpload({ key: avatarKey }).catch(() => {});
    await pages.setBannerFromUpload({ key: bannerKey }).catch(() => {});
    await events
      .finalizeImageUpload({ imageId: "22222222-2222-4222-8222-222222222222" })
      .catch(() => {});

    const finalizeCalls = rateLimit.consume.mock.calls.filter(([key]) => key === KEY);
    expect(finalizeCalls).toHaveLength(4);
    for (const call of finalizeCalls) expect(call).toEqual([KEY, 20, 60]);
  });

  it("another actor's bucket is untouched", async () => {
    const { rateLimit, pages } = callers();
    for (let i = 0; i < 21; i++) {
      await pages.setAvatarFromUpload({ key: avatarKey }).catch(() => {});
    }

    const other = createCaller(entityPagesRouter, {
      repos: repos(),
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: "33333333-3333-4333-8333-333333333333",
    }).caller;
    await expect(other.setAvatarFromUpload({ key: avatarKey })).rejects.not.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});
