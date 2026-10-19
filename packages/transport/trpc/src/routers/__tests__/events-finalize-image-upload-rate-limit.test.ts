import { describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";
import { IMAGE_STRIP_BUSY } from "@th/core/use-cases/storage";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * `events.finalizeImageUpload` is rate-limited per actor: each call may read,
 * strip and rewrite an upload of up to 25 MB (security review N1, fix round 2
 * of the image metadata strip).
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_ID = "22222222-2222-4222-8222-222222222222";
// Shared with the entity-page, avatar and banner finalizes (entity-pages.ts).
const KEY = `images:finalize:${ACTOR_ID}`;

const fakeRateLimit = (deniedKeys: string[] = []) => ({
  consume: vi.fn(async (key: string) =>
    deniedKeys.includes(key)
      ? { allowed: false, remaining: 0, retryAfterSeconds: 7 }
      : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
  ),
});

const repos = () =>
  ({
    // No such image: the use case answers IMAGE_NOT_FOUND once it runs.
    images: { getById: vi.fn(async () => null) },
  }) as unknown as Ctx["repos"];

describe("events.finalizeImageUpload rate limit + RATE_LIMITED mapping", () => {
  it("refuses with TOO_MANY_REQUESTS before the use case runs", async () => {
    const rateLimit = fakeRateLimit([KEY]);
    const r = repos();
    const { caller } = createCaller(eventsRouter, {
      repos: r,
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
    });

    await expect(caller.finalizeImageUpload({ imageId: IMAGE_ID })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(r.images.getById).not.toHaveBeenCalled();
  });

  it("charges the per-actor bucket (20 per minute) and then runs the use case", async () => {
    const rateLimit = fakeRateLimit();
    const r = repos();
    const { caller } = createCaller(eventsRouter, {
      repos: r,
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
    });

    await expect(caller.finalizeImageUpload({ imageId: IMAGE_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(rateLimit.consume).toHaveBeenCalledWith(KEY, 20, 60);
    expect(r.images.getById).toHaveBeenCalledWith(IMAGE_ID);
  });

  it("maps a RATE_LIMITED error from the use case to TOO_MANY_REQUESTS", async () => {
    // Error MAPPING only: the strip queue's real refusal (RATE_LIMITED /
    // image_strip_busy, strip-uploaded-image.ts) is exercised in the core
    // tests. Here a repo throws the same error shape so the test pins how
    // the transport surfaces it: retryable, TOO_MANY_REQUESTS.
    const r = {
      images: {
        getById: vi.fn(async () =>
          fail("RATE_LIMITED", {
            message: IMAGE_STRIP_BUSY,
            meta: { reason: IMAGE_STRIP_BUSY, retryable: true },
          }),
        ),
      },
    } as unknown as Ctx["repos"];
    const { caller } = createCaller(eventsRouter, {
      repos: r,
      rateLimit: fakeRateLimit() as unknown as Ctx["rateLimit"],
      actorHumanId: ACTOR_ID,
    });

    await expect(caller.finalizeImageUpload({ imageId: IMAGE_ID })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
  });
});
