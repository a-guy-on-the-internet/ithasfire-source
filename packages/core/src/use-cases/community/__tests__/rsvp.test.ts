import { describe, expect, it, vi } from "vitest";

import { rsvpToEvent, type RsvpToEventDeps } from "../rsvp-to-event";
import { cancelRsvp, type CancelRsvpDeps } from "../cancel-rsvp";
import { listMyRsvps, type ListMyRsvpsDeps } from "../list-my-rsvps";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventRsvpRecord } from "@th/ports/repos/event-rsvps";
import {
  EVENT_ID,
  NOW,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeOrgEvent,
} from "./helpers";

const RSVP_ID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";

function makeRsvp(overrides: Partial<EventRsvpRecord> = {}): EventRsvpRecord {
  return {
    id: RSVP_ID,
    eventId: EVENT_ID,
    humanId: USER_ID,
    createdAt: NOW,
    ...overrides,
  };
}

function buildRsvpDeps(
  event: EventRecord | null = makeCommunityEvent(),
  opts: { created?: boolean } = {},
) {
  const upsert = vi.fn(async () => ({
    record: makeRsvp(),
    created: opts.created ?? true,
  }));
  const del = vi.fn(async () => undefined);
  const listForUser = vi.fn(async () => ({
    items: [makeRsvp()],
    nextCursor: null,
  }));
  const createNotice = vi.fn(async () => ({
    id: "nnnnnnnn-1111-4111-8111-nnnnnnnnnnnn",
    eventId: EVENT_ID,
    humanId: USER_ID,
    createdAt: NOW,
    dispatchedAt: null,
    attempts: 0,
  }));

  const repos = {
    events: {
      getById: vi.fn(async () => event),
      findManyByIds: vi.fn(async (ids: string[]) =>
        event && ids.includes(event.id) ? [event] : [],
      ),
    },
    eventRsvps: { upsert, delete: del, listForUser },
    rsvpNotices: { create: createNotice },
  };

  const clock = makeClock();

  return {
    deps: { repos, clock } as unknown as RsvpToEventDeps &
      CancelRsvpDeps &
      ListMyRsvpsDeps,
    upsert,
    del,
    listForUser,
    createNotice,
    clock,
  };
}

describe("rsvpToEvent", () => {
  it("RSVPs idempotently via upsert — confirmation enqueued ONLY for the fresh RSVP", async () => {
    const { deps, upsert, createNotice } = buildRsvpDeps();
    // First press creates the row; the re-press reads it back (created: false).
    upsert
      .mockResolvedValueOnce({ record: makeRsvp(), created: true })
      .mockResolvedValueOnce({ record: makeRsvp(), created: false });

    const first = await rsvpToEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
    });
    const second = await rsvpToEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
    });

    expect(first.rsvp.id).toBe(second.rsvp.id);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: USER_ID,
    });
    // Exactly ONE outbox row despite two presses — no duplicate confirmation.
    expect(createNotice).toHaveBeenCalledTimes(1);
    expect(createNotice).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: USER_ID,
    });
  });

  it("does not enqueue a confirmation on an idempotent re-RSVP (created: false)", async () => {
    const { deps, createNotice } = buildRsvpDeps(makeCommunityEvent(), {
      created: false,
    });

    const result = await rsvpToEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
    });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(createNotice).not.toHaveBeenCalled();
  });

  it("a failed confirmation enqueue never fails the RSVP (best-effort)", async () => {
    const { deps, createNotice } = buildRsvpDeps();
    createNotice.mockRejectedValueOnce(new Error("outbox table on fire"));

    // The RSVP row was written; a missed confirmation beats a failed RSVP.
    const result = await rsvpToEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
    });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(createNotice).toHaveBeenCalledTimes(1);
  });

  it("rejects a TICKETED event with EVENT_NOT_COMMUNITY", async () => {
    const { deps, upsert } = buildRsvpDeps(makeOrgEvent());

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMMUNITY" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a missing event with EVENT_NOT_FOUND", async () => {
    const { deps } = buildRsvpDeps(null);

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a non-published event with EVENT_NOT_PUBLISHED (404 category)", async () => {
    const { deps } = buildRsvpDeps(makeCommunityEvent({ status: "CANCELLED" }));

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });

  it("rejects a past-but-still-PUBLISHED event with EVENT_ALREADY_ENDED (endsAt)", async () => {
    // endsAt is before the clock's NOW (2026-07-01) — the event is over.
    const { deps, upsert } = buildRsvpDeps(
      makeCommunityEvent({
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
      }),
    );

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_ENDED" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("uses startsAt as the end when endsAt is null (past start → EVENT_ALREADY_ENDED)", async () => {
    const { deps } = buildRsvpDeps(
      makeCommunityEvent({
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: null,
      }),
    );

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_ENDED" });
  });

  it("treats endsAt EXACTLY at now as ended (locks in the <= boundary)", async () => {
    // endsAt === clock.now() (NOW) — the instant of ending counts as ended.
    // A refactor to `<` would let this through and fail here.
    const { deps, upsert } = buildRsvpDeps(
      makeCommunityEvent({
        startsAt: new Date("2026-07-01T09:00:00.000Z"),
        endsAt: NOW,
      }),
    );

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_ENDED" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("treats startsAt EXACTLY at now as ended when endsAt is null", async () => {
    const { deps } = buildRsvpDeps(
      makeCommunityEvent({ startsAt: NOW, endsAt: null }),
    );

    await expect(
      rsvpToEvent(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_ENDED" });
  });

  it("still accepts a future event (default fixture ends 2026-08-01)", async () => {
    const { deps, upsert } = buildRsvpDeps();

    const result = await rsvpToEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
    });

    expect(result.rsvp.id).toBe(RSVP_ID);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("cancelRsvp", () => {
  it("un-RSVPs idempotently (repeat cancels are no-ops)", async () => {
    const { deps, del } = buildRsvpDeps();

    await expect(
      cancelRsvp(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ ok: true });
    await expect(
      cancelRsvp(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ ok: true });
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("still lets a user withdraw from an already-ENDED published event (cancel is ungated)", async () => {
    // Past-but-still-PUBLISHED event: RSVP is blocked, but withdrawal must
    // always work — cancelRsvp deliberately has no event-state gating.
    const { deps, del } = buildRsvpDeps(
      makeCommunityEvent({
        startsAt: new Date("2026-06-01T20:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"),
      }),
    );

    await expect(
      cancelRsvp(deps, { actorHumanId: USER_ID, eventId: EVENT_ID }),
    ).resolves.toEqual({ ok: true });
    expect(del).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: USER_ID,
    });
  });
});

describe("listMyRsvps", () => {
  it("returns the caller's own RSVPs hydrated with event summaries — no counts anywhere", async () => {
    const { deps, listForUser } = buildRsvpDeps();

    const result = await listMyRsvps(deps, { actorHumanId: USER_ID });

    expect(listForUser).toHaveBeenCalledWith({
      humanId: USER_ID,
      cursor: null,
      limit: undefined,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.event).toMatchObject({
      id: EVENT_ID,
      title: "Weekly Open Mic",
      attendanceMode: "RSVP",
    });
    // Output shape carries no aggregate/going-count field.
    expect(JSON.stringify(result)).not.toMatch(/count/i);
  });

  it("drops rows whose event vanished in a delete race", async () => {
    const { deps } = buildRsvpDeps(null);

    const result = await listMyRsvps(deps, { actorHumanId: USER_ID });
    expect(result.items).toEqual([]);
  });
});
