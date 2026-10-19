import { describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import { listMyRsvps } from "../list-my-rsvps";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const RSVP_ID = "33333333-3333-4333-8333-333333333333";
const HERO_KEY = "events/e/images/hero.png";
const HERO_URL = "https://cdn.example/events/e/images/hero.png";

const heroEvent = () =>
  ({
    id: EVENT_ID,
    title: "Community Potluck",
    slug: "community-potluck",
    status: "PUBLISHED",
    attendanceMode: "RSVP",
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: null,
    timezone: "America/Chicago",
    addressText: "123 Main St",
    locality: "Nashville",
    region: "TN",
    heroImageUrl: HERO_URL,
    heroImageKey: HERO_KEY,
  }) as unknown as EventRecord;

function makeDeps(statusByKey: Record<string, ImageModerationStatus> = {}) {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    eventRsvps: {
      listForUser: vi.fn(async () => ({
        items: [
          {
            id: RSVP_ID,
            eventId: EVENT_ID,
            humanId: ACTOR,
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        ],
        nextCursor: null,
      })),
    },
    events: { findManyByIds: vi.fn(async () => [heroEvent()]) },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;
  return {
    deps: { repos, logger: createTestLogger() },
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("listMyRsvps hero moderation gate (FR-005)", () => {
  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const { deps, resolveByKeys } = makeDeps({ [HERO_KEY]: "APPROVED" });
    const result = await listMyRsvps(deps, { actorHumanId: ACTOR });
    expect(result.items[0]!.event.heroImageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero on the RSVPer's own list",
    async (status) => {
      const { deps } = makeDeps({ [HERO_KEY]: status });
      const result = await listMyRsvps(deps, { actorHumanId: ACTOR });
      expect(result.items[0]!.event.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const { deps } = makeDeps({});
    const result = await listMyRsvps(deps, { actorHumanId: ACTOR });
    expect(result.items[0]!.event.heroImageUrl).toBe(HERO_URL);
  });
});
