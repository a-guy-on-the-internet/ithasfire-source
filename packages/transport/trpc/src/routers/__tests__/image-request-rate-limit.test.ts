import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { entityPagesRouter } from "../entity-pages";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * Every upload request writes an `upload-request` outbox row, so the four
 * request procedures charge ONE per-actor bucket (security review R3-2).
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const KEY = `images:request:${ACTOR_ID}`;

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

function callers(actorHumanId = ACTOR_ID, rl = countingRateLimit()) {
  const ctx = {
    // The use cases never get a usable repo: each call fails after the limiter.
    repos: {} as unknown as Ctx["repos"],
    rateLimit: rl as unknown as Ctx["rateLimit"],
    actorHumanId,
  };
  return {
    rateLimit: rl,
    pages: createCaller(entityPagesRouter, ctx).caller,
    events: createCaller(eventsRouter, ctx).caller,
  };
}

const avatar = { contentType: "image/jpeg", sizeBytes: 1000 } as const;
const banner = { contentType: "image/jpeg", sizeBytes: 1000 } as const;
const page = {
  ownerType: "HUMAN",
  ownerId: ACTOR_ID,
  contentType: "image/jpeg",
  sizeBytes: 1000,
} as const;
const event = { eventId: "evt_1", contentType: "image/jpeg", sizeBytes: 1000 } as const;

const tooMany = { code: "TOO_MANY_REQUESTS" };

describe("image upload requests share one per-actor rate-limit bucket", () => {
  it("20 avatar requests spend the bucket: the next page, banner and event requests are refused", async () => {
    const { rateLimit, pages, events } = callers();

    for (let i = 0; i < 20; i++) {
      await expect(pages.requestAvatarUpload(avatar)).rejects.not.toMatchObject(tooMany);
    }

    await expect(pages.requestImageUpload(page as never)).rejects.toMatchObject(tooMany);
    await expect(pages.requestBannerUpload(banner)).rejects.toMatchObject(tooMany);
    await expect(events.requestImageUpload(event as never)).rejects.toMatchObject(tooMany);

    expect(rateLimit.counts.get(KEY)).toBe(23);
  });

  it("each of the four charges the same key, 20 per 60 s", async () => {
    const { rateLimit, pages, events } = callers();

    await pages.requestImageUpload(page as never).catch(() => {});
    await pages.requestAvatarUpload(avatar).catch(() => {});
    await pages.requestBannerUpload(banner).catch(() => {});
    await events.requestImageUpload(event as never).catch(() => {});

    const calls = rateLimit.consume.mock.calls.filter(([key]) => key === KEY);
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call).toEqual([KEY, 20, 60]);
  });

  it("another actor's bucket is untouched", async () => {
    const { rateLimit, pages } = callers();
    for (let i = 0; i < 21; i++) await pages.requestAvatarUpload(avatar).catch(() => {});

    const other = callers(OTHER_ID, rateLimit).pages;
    await expect(other.requestAvatarUpload(avatar)).rejects.not.toMatchObject(tooMany);
  });
});
