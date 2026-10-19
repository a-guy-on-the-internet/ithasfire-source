import { describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import { listOrganizerEvents } from "../list-organizer-events";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment; no fixture here carries a schedule, so
// the resolved price is the list price and every existing expectation holds.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const CURRENT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const HERO_KEY = "events/e/images/hero.png";
const HERO_URL = "https://cdn.example/events/e/images/hero.png";

const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

const currentEvent = () =>
  ({ id: CURRENT_EVENT_ID, orgId: ORG_ID }) as unknown as EventRecord;

const siblingEvent = () =>
  ({
    id: SIBLING_ID,
    orgId: ORG_ID,
    title: "Sibling Show",
    slug: "sibling-show",
    startsAt: future,
    endsAt: null,
    heroImageUrl: HERO_URL,
    heroImageKey: HERO_KEY,
    locality: "Nashville",
    region: "TN",
    currency: "usd",
  }) as unknown as EventRecord;

function makeDeps(statusByKey: Record<string, ImageModerationStatus> = {}) {
  const gate = makeImageModerationGateFake(statusByKey);
  const repos = {
    events: {
      getById: vi.fn(async () => currentEvent()),
      listByOwner: vi.fn(async () => ({ items: [siblingEvent()] })),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        name: "Demo Org",
        slug: "demo-org",
      })),
    },
    imageModerationRecords: gate.imageModerationRecords,
  } as unknown as Repos;
  return {
    deps: { repos, clock: testClock, logger: createTestLogger() },
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("listOrganizerEvents hero moderation gate (FR-005)", () => {
  it("shows an APPROVED sibling hero and batches one resolveByKeys call", async () => {
    const { deps, resolveByKeys } = makeDeps({ [HERO_KEY]: "APPROVED" });
    const result = await listOrganizerEvents(deps, {
      eventId: CURRENT_EVENT_ID,
    });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s sibling hero",
    async (status) => {
      const { deps } = makeDeps({ [HERO_KEY]: status });
      const result = await listOrganizerEvents(deps, {
        eventId: CURRENT_EVENT_ID,
      });
      expect(result.events[0]!.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy sibling hero with NO moderation record", async () => {
    const { deps } = makeDeps({});
    const result = await listOrganizerEvents(deps, {
      eventId: CURRENT_EVENT_ID,
    });
    expect(result.events[0]!.heroImageUrl).toBe(HERO_URL);
  });
});
