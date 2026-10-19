import { describe, expect, it, vi } from "vitest";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { createTestLogger } from "@th/test-utils";
import { communityRouter } from "../community";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const row = {
  id: EVENT_ID,
  title: "Open mic",
  status: "PUBLISHED" as const,
  slug: "open-mic--abc123",
  timezone: "America/Chicago",
  startsAt: new Date("2026-07-15T23:00:00.000Z"),
  endsAt: new Date("2026-07-16T02:00:00.000Z"),
  recurring: false,
  placeId: null,
  placeName: null,
  placeCity: null,
  locality: "Nashville",
  nextScheduledDateStartsAt: null,
  upcomingScheduledDateCount: 0,
  publishedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

function buildCtx(opts: {
  actorHumanId?: string | null;
  roles?: string[];
}) {
  const listCommunityListingsForPlatform = vi.fn(async () => ({
    items: [row],
    nextCursor: null,
  }));
  const hasStaffRole = vi.fn(
    async ({ requiredRoles }: { requiredRoles: string[] }) => ({
      allowed: (opts.roles ?? []).some((role) => requiredRoles.includes(role)),
    }),
  );
  const ctx = {
    repos: { events: { listCommunityListingsForPlatform } },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
    rateLimit: withConsumeMany({
      consume: vi.fn(async () => ({
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterSeconds: 0,
      })),
    }),
    logger: createTestLogger(),
    actorHumanId: opts.actorHumanId === undefined ? ADMIN_ID : opts.actorHumanId,
    ...(opts.actorHumanId === null
      ? { auth: null, authToken: null }
      : {
          auth: { userId: "user-1", sessionId: null, token: "token" },
          authToken: "token",
        }),
    apiKey: null,
    clientIp: "203.0.113.9",
  } as unknown as Ctx;
  return { ctx, listCommunityListingsForPlatform, hasStaffRole };
}

const callerFor = (ctx: Ctx) =>
  trpcRouter({ community: router(communityRouter) }).createCaller(ctx);

describe("community.listListingsForPlatform", () => {
  it("returns the page for a platform ADMIN, actor from ctx", async () => {
    const { ctx, listCommunityListingsForPlatform, hasStaffRole } = buildCtx({
      roles: ["ADMIN"],
    });

    const result = await callerFor(ctx).community.listListingsForPlatform({
      status: "PUBLISHED",
      query: "open",
      limit: 10,
    });

    expect(hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({ actorHumanId: ADMIN_ID }),
    );
    expect(listCommunityListingsForPlatform).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["PUBLISHED"],
        titleContains: "open",
        limit: 10,
      }),
    );
    expect(result.items[0]).toMatchObject({
      id: EVENT_ID,
      city: "Nashville",
      nextNightStartsAt: row.startsAt,
      upcomingNightCount: 1,
    });
    expect(result.nextCursor).toBeNull();
  });

  it("refuses a COMMUNITY_MODERATOR as FORBIDDEN (STAFF_ONLY)", async () => {
    const { ctx, listCommunityListingsForPlatform } = buildCtx({
      roles: ["COMMUNITY_MODERATOR"],
    });

    await expect(
      callerFor(ctx).community.listListingsForPlatform({}),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listCommunityListingsForPlatform).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller as UNAUTHORIZED", async () => {
    const { ctx, listCommunityListingsForPlatform } = buildCtx({
      actorHumanId: null,
    });

    await expect(
      callerFor(ctx).community.listListingsForPlatform({}),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(listCommunityListingsForPlatform).not.toHaveBeenCalled();
  });

  it("does not accept an actorHumanId from the client", async () => {
    const { ctx, listCommunityListingsForPlatform } = buildCtx({
      roles: ["ADMIN"],
    });

    await expect(
      callerFor(ctx).community.listListingsForPlatform({
        actorHumanId: ADMIN_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(listCommunityListingsForPlatform).not.toHaveBeenCalled();
  });
});
