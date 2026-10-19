import { describe, expect, it, vi } from "vitest";

import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import { saveEvent } from "../save-event";
import { unsaveEvent } from "../unsave-event";
import { listSavedEvents } from "../list-saved-events";
import { getSavedState } from "../get-saved-state";

const ACTOR_ID = "human-actor";
const OTHER_ACTOR_ID = "human-other";
const NOW = new Date("2026-07-01T12:00:00.000Z");
const CREATED_AT = new Date("2026-06-15T00:00:00.000Z");

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const PAST_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const CANCELLED_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const HIDDEN_EVENT_ID = "44444444-4444-4444-8444-444444444444";
const COMPLETED_EVENT_ID = "66666666-6666-4666-8666-666666666666";
const MISSING_EVENT_ID = "99999999-9999-4999-8999-999999999999";

type FakeEvent = {
  id: string;
  slug: string | null;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED" | "CANCELLED" | "COMPLETED";
  visibility: "PUBLIC" | "PRIVATE";
  heroImageId: string | null;
  heroImageUrl: string | null;
  heroImageKey: string | null;
  addressText: string | null;
  locationLabel: string | null;
  placeId: string | null;
};

type SaveRecord = {
  id: string;
  eventId: string;
  humanId: string;
  createdAt: Date;
};

function makeEvent(overrides: Partial<FakeEvent> & { id: string }): FakeEvent {
  return {
    slug: "test-event",
    title: "Test Event",
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: null,
    timezone: "America/Chicago",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    heroImageId: null,
    heroImageUrl: null,
    heroImageKey: null,
    addressText: "123 Main St",
    locationLabel: null,
    placeId: null,
    ...overrides,
  };
}

function makeDeps(
  eventList?: FakeEvent[],
  statusByKey: Record<string, ImageModerationStatus> = {},
) {
  const gate = makeImageModerationGateFake(statusByKey);
  const events = new Map<string, FakeEvent>(
    (
      eventList ?? [
        makeEvent({ id: EVENT_ID }),
        makeEvent({
          id: PAST_EVENT_ID,
          startsAt: new Date("2026-05-01T20:00:00.000Z"),
        }),
        makeEvent({ id: CANCELLED_EVENT_ID, status: "CANCELLED" }),
        makeEvent({ id: HIDDEN_EVENT_ID, status: "DRAFT" }),
        makeEvent({
          id: COMPLETED_EVENT_ID,
          status: "COMPLETED",
          startsAt: new Date("2026-04-01T20:00:00.000Z"),
        }),
      ]
    ).map((event) => [event.id, event]),
  );

  const saves = new Map<string, SaveRecord>();
  let seq = 0;

  const eventSavesRepo = {
    upsert: vi.fn(async (input: { eventId: string; humanId: string }) => {
      const key = `${input.eventId}:${input.humanId}`;
      const existing = saves.get(key);
      if (existing) {
        return { save: existing, created: false };
      }

      const created: SaveRecord = {
        id: `save-${++seq}`,
        eventId: input.eventId,
        humanId: input.humanId,
        createdAt: new Date(CREATED_AT.getTime() + seq * 1000),
      };
      saves.set(key, created);
      return { save: created, created: true };
    }),
    delete: vi.fn(async (input: { eventId: string; humanId: string }) => {
      const key = `${input.eventId}:${input.humanId}`;
      const existing = saves.get(key) ?? null;
      saves.delete(key);
      return {
        deleted: Boolean(existing),
        saveId: existing?.id ?? null,
      };
    }),
    existsForUser: vi.fn(
      async (input: { eventId: string; humanId: string }) =>
        saves.has(`${input.eventId}:${input.humanId}`),
    ),
    listForHuman: vi.fn(
      async (input: {
        humanId: string;
        scope: "upcoming" | "past";
        cursor?: string | null;
        limit?: number;
        now?: Date;
      }) => {
        const boundary = input.now ?? NOW;
        const items = [...saves.values()]
          .filter((save) => save.humanId === input.humanId)
          .map((save) => ({
            ...save,
            event: events.get(save.eventId)!,
          }))
          .filter((item) =>
            input.scope === "upcoming"
              ? item.event.startsAt >= boundary
              : item.event.startsAt < boundary,
          )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return { items, nextCursor: null };
      },
    ),
    getSavedStateForEvents: vi.fn(
      async (input: { humanId: string; eventIds: string[] }) => {
        const state: Record<string, boolean> = {};
        for (const eventId of input.eventIds) {
          state[eventId] = saves.has(`${eventId}:${input.humanId}`);
        }
        return state;
      },
    ),
    listHumanIdsForEvent: vi.fn(),
  };

  const eventsRepo = {
    getById: vi.fn(async (id: string) => {
      const event = events.get(id);
      return event ? { ...event } : null;
    }),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const txRepos = {
    eventSaves: eventSavesRepo,
    events: eventsRepo,
    audit: auditRepo,
  };

  return {
    deps: {
      repos: {
        eventSaves: eventSavesRepo,
        events: eventsRepo,
        audit: auditRepo,
        imageModerationRecords: gate.imageModerationRecords,
        tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
          fn(txRepos),
        ),
      },
      clock: { now: () => NOW },
    } as any,
    saves,
    eventSavesRepo,
    eventsRepo,
    auditRepo,
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("event-saves slice", () => {
  it("saving twice is idempotent — one row, same saveId", async () => {
    const { deps, saves, auditRepo } = makeDeps();

    const first = await saveEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });
    const second = await saveEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(first.alreadySaved).toBe(false);
    expect(second.alreadySaved).toBe(true);
    expect(second.saveId).toBe(first.saveId);
    expect(saves.size).toBe(1);
    // Audit only on actual creation.
    expect(auditRepo.log).toHaveBeenCalledTimes(1);
  });

  it("unsave is idempotent even when no save exists", async () => {
    const { deps, auditRepo } = makeDeps();

    await expect(
      unsaveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ success: true });
    expect(auditRepo.log).not.toHaveBeenCalled();

    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });
    await expect(
      unsaveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ success: true });
    await expect(
      unsaveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ success: true });
  });

  it("rejects saving a missing event", async () => {
    const { deps } = makeDeps();

    await expect(
      saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: MISSING_EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects saving a non-PUBLISHED event", async () => {
    const { deps } = makeDeps();

    await expect(
      saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: HIDDEN_EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("list keeps CANCELLED and COMPLETED saves but filters newly-hidden events", async () => {
    const { deps, saves } = makeDeps();

    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });
    // Hidden/cancelled/completed events can't be newly saved; seed the rows
    // directly to model saves that predate the status change (drift).
    saves.set(`${HIDDEN_EVENT_ID}:${ACTOR_ID}`, {
      id: "save-hidden",
      eventId: HIDDEN_EVENT_ID,
      humanId: ACTOR_ID,
      createdAt: CREATED_AT,
    });
    saves.set(`${CANCELLED_EVENT_ID}:${ACTOR_ID}`, {
      id: "save-cancelled",
      eventId: CANCELLED_EVENT_ID,
      humanId: ACTOR_ID,
      createdAt: CREATED_AT,
    });
    saves.set(`${COMPLETED_EVENT_ID}:${ACTOR_ID}`, {
      id: "save-completed",
      eventId: COMPLETED_EVENT_ID,
      humanId: ACTOR_ID,
      createdAt: CREATED_AT,
    });

    const result = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });

    const ids = result.items.map((item) => item.event.id);
    expect(ids).toContain(EVENT_ID);
    expect(ids).toContain(CANCELLED_EVENT_ID);
    expect(ids).not.toContain(HIDDEN_EVENT_ID);
    expect(
      result.items.find((item) => item.event.id === CANCELLED_EVENT_ID)?.event
        .status,
    ).toBe("CANCELLED");

    // COMPLETED events happened — they belong in the Past tab, still visible.
    const past = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "past",
    });
    const pastIds = past.items.map((item) => item.event.id);
    expect(pastIds).toContain(COMPLETED_EVENT_ID);
    expect(
      past.items.find((item) => item.event.id === COMPLETED_EVENT_ID)?.event
        .status,
    ).toBe("COMPLETED");
  });

  it("preserves nextCursor when visibility filtering shrinks the page", async () => {
    const { deps, eventSavesRepo } = makeDeps();

    const page = {
      items: [
        {
          id: "save-1",
          eventId: EVENT_ID,
          humanId: ACTOR_ID,
          createdAt: CREATED_AT,
          event: makeEvent({
            id: EVENT_ID,
            heroImageId: "img-1",
            heroImageUrl: "https://img.test/hero-1.jpg",
          }),
        },
        {
          id: "save-2",
          eventId: HIDDEN_EVENT_ID,
          humanId: ACTOR_ID,
          createdAt: CREATED_AT,
          event: makeEvent({ id: HIDDEN_EVENT_ID, status: "DRAFT" as const }),
        },
        {
          id: "save-3",
          eventId: CANCELLED_EVENT_ID,
          humanId: ACTOR_ID,
          createdAt: CREATED_AT,
          event: makeEvent({
            id: CANCELLED_EVENT_ID,
            status: "CANCELLED" as const,
          }),
        },
      ],
      nextCursor: "2026-06-15T00:00:00.000Z|save-3",
    };
    eventSavesRepo.listForHuman.mockResolvedValueOnce(page as never);

    const result = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });

    // The hidden event is dropped (page shrinks below the repo page size)…
    expect(result.items.map((item) => item.saveId)).toEqual([
      "save-1",
      "save-3",
    ]);
    // …but the cursor still advances past the FULL repo page.
    expect(result.nextCursor).toBe(page.nextCursor);

    // The resolved hero URL passes through the summary untouched.
    expect(result.items[0]?.event.heroImageUrl).toBe(
      "https://img.test/hero-1.jpg",
    );
    expect(result.items[1]?.event.heroImageUrl).toBeNull();
  });

  // ── Hero moderation gate (FR-005) ────────────────────────────────────
  const HERO_KEY = "events/e/images/hero.png";
  const HERO_URL = "https://cdn.example/events/e/images/hero.png";

  const runSavedWithHero = async (
    statusByKey: Record<string, ImageModerationStatus>,
  ) => {
    const { deps, eventSavesRepo, resolveByKeys } = makeDeps(
      undefined,
      statusByKey,
    );
    const page = {
      items: [
        {
          id: "save-1",
          eventId: EVENT_ID,
          humanId: ACTOR_ID,
          createdAt: CREATED_AT,
          event: makeEvent({
            id: EVENT_ID,
            heroImageId: "img-1",
            heroImageUrl: HERO_URL,
            heroImageKey: HERO_KEY,
          }),
        },
      ],
      nextCursor: null,
    };
    eventSavesRepo.listForHuman.mockResolvedValueOnce(page as never);
    const result = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });
    return { heroImageUrl: result.items[0]?.event.heroImageUrl, resolveByKeys };
  };

  it("shows an APPROVED hero and batches one resolveByKeys call", async () => {
    const { heroImageUrl, resolveByKeys } = await runSavedWithHero({
      [HERO_KEY]: "APPROVED",
    });
    expect(heroImageUrl).toBe(HERO_URL);
    expect(resolveByKeys).toHaveBeenCalledTimes(1);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero on the saver's own list",
    async (status) => {
      const { heroImageUrl } = await runSavedWithHero({ [HERO_KEY]: status });
      expect(heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero with NO moderation record", async () => {
    const { heroImageUrl } = await runSavedWithHero({});
    expect(heroImageUrl).toBe(HERO_URL);
  });

  it("HIDDEN_EVENT save row exists even though the list filters it (no side effects on the row)", async () => {
    const { deps, saves } = makeDeps();

    // Model visibility drift: saved while PUBLISHED, later unpublished.
    saves.set(`${HIDDEN_EVENT_ID}:${ACTOR_ID}`, {
      id: "save-hidden",
      eventId: HIDDEN_EVENT_ID,
      humanId: ACTOR_ID,
      createdAt: CREATED_AT,
    });

    const result = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });

    expect(result.items).toHaveLength(0);
    expect(saves.has(`${HIDDEN_EVENT_ID}:${ACTOR_ID}`)).toBe(true);
  });

  it("splits upcoming vs past by startsAt", async () => {
    const { deps } = makeDeps();

    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });
    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: PAST_EVENT_ID });

    const upcoming = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });
    const past = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "past",
    });

    expect(upcoming.items.map((item) => item.event.id)).toEqual([EVENT_ID]);
    expect(past.items.map((item) => item.event.id)).toEqual([PAST_EVENT_ID]);
  });

  it("sends each event's own zone, and the platform default for an unusable one", async () => {
    // The home strip formats the start in this zone (never the viewer's), and
    // `Intl` throws on an unusable name, so the DTO only ever carries a usable one.
    const DENVER_ID = "77777777-7777-4777-8777-777777777777";
    const BROKEN_ID = "88888888-8888-4888-8888-888888888888";
    const { deps } = makeDeps([
      makeEvent({ id: DENVER_ID, timezone: "America/Denver" }),
      makeEvent({ id: BROKEN_ID, timezone: "Not/AZone" }),
    ]);
    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: DENVER_ID });
    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: BROKEN_ID });

    const result = await listSavedEvents(deps, {
      actorHumanId: ACTOR_ID,
      scope: "upcoming",
    });
    const zoneOf = (id: string) =>
      result.items.find((item) => item.event.id === id)?.event.timezone;

    expect(zoneOf(DENVER_ID)).toBe("America/Denver");
    expect(zoneOf(BROKEN_ID)).toBe("America/Chicago");
  });

  it("savedState returns correct flags with an entry for every requested id", async () => {
    const { deps } = makeDeps();

    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    const result = await getSavedState(deps, {
      actorHumanId: ACTOR_ID,
      eventIds: [EVENT_ID, PAST_EVENT_ID],
    });

    expect(result.saved).toEqual({
      [EVENT_ID]: true,
      [PAST_EVENT_ID]: false,
    });
  });

  it("savedState rejects more than 50 eventIds", async () => {
    const { deps } = makeDeps();

    const eventIds = Array.from(
      { length: 51 },
      (_, i) =>
        `55555555-5555-4555-8555-${String(i).padStart(12, "0")}`,
    );

    await expect(
      getSavedState(deps, { actorHumanId: ACTOR_ID, eventIds }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not leak one user's saves to another (list and savedState)", async () => {
    const { deps } = makeDeps();

    await saveEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    const otherList = await listSavedEvents(deps, {
      actorHumanId: OTHER_ACTOR_ID,
      scope: "upcoming",
    });
    expect(otherList.items).toHaveLength(0);

    const otherState = await getSavedState(deps, {
      actorHumanId: OTHER_ACTOR_ID,
      eventIds: [EVENT_ID],
    });
    expect(otherState.saved).toEqual({ [EVENT_ID]: false });
  });
});
