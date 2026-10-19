import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventRecord } from "@th/ports/repos/events";
import type { TxRepos } from "@th/ports/repos";
import type { EventChangeNoticeRecord } from "@th/ports/repos/event-change-notices";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

import {
  dispatchEventChangeNotifications,
  type DispatchEventChangeNotificationsDeps,
} from "../dispatch-event-change-notifications";
import { saveEventForHuman } from "../save-event-for-human";
import { saveEventForOrg } from "../save-event-for-org";

// ─────────────────────────────────────────────────────────────────────────────
// FR-013 on the OWNED save path: moving a PUBLISHED event's schedule writes the
// same RESCHEDULED outbox row the community edit path writes
// (`recordCommunityEditApplied`), in the save's own tx, so savers and RSVPers
// are told. Mirrors community/__tests__/update-community-listing.test.ts
// ("writes exactly ONE RESCHEDULED notice, in the same tx").
// ─────────────────────────────────────────────────────────────────────────────

const OLD_START = "2024-02-01T18:00:00.000Z";
const OLD_END = "2024-02-01T19:00:00.000Z";
const NEW_START = "2024-02-02T19:00:00.000Z";
const NEW_END = "2024-02-02T22:00:00.000Z";

function makeExistingEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Existing",
    status: "PUBLISHED",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    timezone: "America/Chicago",
    startsAt: new Date(OLD_START),
    endsAt: new Date(OLD_END),
    placeId: DEFAULT_PLACE_ID,
    savedLocationId: null,
    spaceId: null,
    calendarId: null,
    categoryId: null,
    categorySeoType: null,
    addressText: null,
    countryCode: null,
    region: null,
    locality: null,
    postalCode: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: new Date("2024-01-01T00:00:00.000Z"),
    payoutTermsId: null,
    resalePayoutTermsId: null,
    agreementPrimaryId: null,
    agreementResaleId: null,
    placeLayoutId: null,
    defaultLocale: "en-US",
    listingPriority: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    waitlistStatus: "CLOSED",
    ...overrides,
  } as EventRecord;
}

function makeOrgInput(overrides: Record<string, unknown> = {}) {
  return {
    eventId: DEFAULT_EVENT_ID,
    actorHumanId: DEFAULT_ACTOR_ID,
    orgId: DEFAULT_ORG_ID,
    title: "Existing",
    startsAt: OLD_START,
    endsAt: OLD_END,
    location: { placeId: DEFAULT_PLACE_ID },
    timezone: "America/Chicago",
    clientKey: `key-${Math.random()}`,
    ...overrides,
  };
}

/** Wraps the fake tx so a test can tell whether a write happened INSIDE it. */
function build(existing: EventRecord) {
  const ctx = makeCreateEventTestContext({ existingEvent: existing });
  const state = { inTx: false };
  const writesInTx: boolean[] = [];
  const originalTx = ctx.deps.repos.tx;
  ctx.deps.repos.tx = (async <T>(fn: (tx: TxRepos) => Promise<T>) =>
    originalTx(async (tx) => {
      state.inTx = true;
      try {
        return await fn(tx);
      } finally {
        state.inTx = false;
      }
    })) as typeof originalTx;
  const create = ctx.mocks.eventChangeNotices.create;
  const original = create.getMockImplementation()!;
  create.mockImplementation(async (input) => {
    writesInTx.push(state.inTx);
    return original(input);
  });
  return { ctx, create, writesInTx };
}

describe("saveEventForOrg — RESCHEDULED change notice", () => {
  it("PUBLISHED event, start moved → exactly ONE RESCHEDULED notice with the new schedule, in the same tx", async () => {
    const { ctx, create, writesInTx } = build(makeExistingEvent());

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ startsAt: NEW_START, endsAt: NEW_END }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Existing",
        newStartsAt: NEW_START,
        newEndsAt: NEW_END,
      },
    });
    expect(writesInTx).toEqual([true]);
  });

  it("PUBLISHED event, only the end moved → ONE notice (end is part of the schedule)", async () => {
    const { ctx, create } = build(makeExistingEvent());

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ endsAt: "2024-02-01T21:00:00.000Z" }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Existing",
        newStartsAt: OLD_START,
        newEndsAt: "2024-02-01T21:00:00.000Z",
      },
    });
  });

  it("the title in the notice is the one the audience knows (the pre-save title), even when the same save renames it", async () => {
    const { ctx, create } = build(makeExistingEvent());

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ title: "Renamed", startsAt: NEW_START, endsAt: NEW_END }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].payload).toMatchObject({
      eventTitle: "Existing",
    });
  });

  it("PUBLISHED event, same instants written in a different string form → no notice (instants, not strings)", async () => {
    const { ctx, create } = build(makeExistingEvent());

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({
        startsAt: "2024-02-01T12:00:00.000-06:00",
        endsAt: "2024-02-01T13:00:00-06:00",
      }),
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("PUBLISHED event, title-only edit → no notice", async () => {
    const { ctx, create } = build(makeExistingEvent());

    await saveEventForOrg(ctx.deps, makeOrgInput({ title: "Renamed" }));

    expect(create).not.toHaveBeenCalled();
  });

  it("PUBLISHED event, timezone-only edit → no notice (a zone edit is presentational)", async () => {
    const { ctx, create } = build(makeExistingEvent());

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ timezone: "America/New_York" }),
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("DRAFT event moved → no notice (a draft has no audience)", async () => {
    const { ctx, create } = build(
      makeExistingEvent({ status: "DRAFT", publishedAt: null }),
    );

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ startsAt: NEW_START, endsAt: NEW_END }),
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("published by a concurrent save between the pre-tx read and the lock, but this save writes DRAFT back → no notice (PUBLISHED before AND after)", async () => {
    const draft = makeExistingEvent({ status: "DRAFT", publishedAt: null });
    const publishedMeanwhile = makeExistingEvent();
    const { ctx, create } = build(draft);
    const events = ctx.mocks.events;
    const upsert = vi.mocked(events.upsertDraft);
    let locked = false;
    vi.mocked(events.lockRows).mockImplementation(async () => {
      locked = true;
    });
    // Pre-tx read → DRAFT; the read under the lock → PUBLISHED (the concurrent
    // publish committed); after the write → the row this save wrote.
    vi.mocked(events.getById).mockImplementation(async (id: string) => {
      if (id !== DEFAULT_EVENT_ID) return null;
      const written = upsert.mock.results.at(-1);
      if (written) return (await written.value) as EventRecord;
      return locked ? publishedMeanwhile : draft;
    });

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ startsAt: NEW_START, endsAt: NEW_END }),
    );

    // The harness really did take the locked path and write DRAFT back.
    expect(events.lockRows).toHaveBeenCalled();
    expect(upsert.mock.calls.at(-1)![0]).toMatchObject({ status: "DRAFT" });
    // …and the before-row the gate saw WAS the published one, so only the
    // after-status check can be what stops the notice.
    const reads = await Promise.all(
      vi.mocked(events.getById).mock.results.map((r) => r.value),
    );
    expect(reads).toContain(publishedMeanwhile);
    expect(create).not.toHaveBeenCalled();
  });

  it("a CREATE (no existing event) writes no notice", async () => {
    const ctx = makeCreateEventTestContext();

    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ eventId: undefined, startsAt: NEW_START, endsAt: NEW_END }),
    );

    expect(ctx.mocks.events.upsertDraft).toHaveBeenCalled();
    expect(ctx.mocks.eventChangeNotices.create).not.toHaveBeenCalled();
  });

  it("the payload it writes is one the drain accepts: dispatched as event.changed to savers", async () => {
    const { ctx, create } = build(makeExistingEvent());
    await saveEventForOrg(
      ctx.deps,
      makeOrgInput({ startsAt: NEW_START, endsAt: NEW_END }),
    );
    const written = await create.mock.results[0]!.value;

    const SAVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const outbox: EventChangeNoticeRecord[] = [{ ...written }];
    const notify = vi.fn(async () => ({ ok: true }));
    const clock: ClockPort = { now: () => new Date("2024-02-01T00:00:00.000Z") };
    const logger = {
      child: vi.fn(),
      withTime: vi.fn(),
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    logger.child.mockReturnValue(logger);
    const deps: DispatchEventChangeNotificationsDeps = {
      repos: {
        eventChangeNotices: {
          create: vi.fn(),
          listUndispatched: vi.fn(async () =>
            outbox.filter((n) => n.dispatchedAt === null),
          ),
          markDispatched: vi.fn(async (ids: string[], at: Date) => {
            for (const n of outbox) if (ids.includes(n.id)) n.dispatchedAt = at;
          }),
          incrementAttempts: vi.fn(async () => undefined),
          markNotified: vi.fn(async () => undefined),
        },
        eventSaves: {
          listHumanIdsForEvent: vi.fn(async () => ({
            items: [SAVER],
            nextCursor: null,
          })),
        },
        eventRsvps: {
          listHumanIdsForEvent: vi.fn(async () => ({
            items: [],
            nextCursor: null,
          })),
        },
        events: {
          getById: vi.fn(async () => ({ id: DEFAULT_EVENT_ID, slug: "x/us/y/z--ab12cd" })),
        },
      } as unknown as DispatchEventChangeNotificationsDeps["repos"],
      notify: notify as unknown as DispatchEventChangeNotificationsDeps["notify"],
      clock,
      logger: logger as unknown as DispatchEventChangeNotificationsDeps["logger"],
      appBaseUrl: "https://ithasfire.com",
    };

    const result = await dispatchEventChangeNotifications(deps, {});

    expect(result.dispatched).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls[0])).toContain("event.changed");
    expect(deps.repos.eventChangeNotices.incrementAttempts).not.toHaveBeenCalled();
  });
});

describe("saveEventForHuman — RESCHEDULED change notice", () => {
  it("person-owned PUBLISHED event, start moved → exactly ONE RESCHEDULED notice", async () => {
    const { ctx, create, writesInTx } = build(
      makeExistingEvent({ orgId: null, humanId: DEFAULT_ACTOR_ID }),
    );

    await saveEventForHuman(ctx.deps, {
      eventId: DEFAULT_EVENT_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      title: "Existing",
      startsAt: NEW_START,
      endsAt: NEW_END,
      location: { placeId: DEFAULT_PLACE_ID },
      timezone: "America/Chicago",
      clientKey: `key-${Math.random()}`,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      eventId: DEFAULT_EVENT_ID,
      changeType: "RESCHEDULED",
      payload: {
        eventTitle: "Existing",
        newStartsAt: NEW_START,
        newEndsAt: NEW_END,
      },
    });
    expect(writesInTx).toEqual([true]);
  });

  it("person-owned PUBLISHED event, no schedule change → no notice", async () => {
    const { ctx, create } = build(
      makeExistingEvent({ orgId: null, humanId: DEFAULT_ACTOR_ID }),
    );

    await saveEventForHuman(ctx.deps, {
      eventId: DEFAULT_EVENT_ID,
      actorHumanId: DEFAULT_ACTOR_ID,
      title: "Renamed",
      startsAt: OLD_START,
      endsAt: OLD_END,
      location: { placeId: DEFAULT_PLACE_ID },
      timezone: "America/Chicago",
      clientKey: `key-${Math.random()}`,
    });

    expect(create).not.toHaveBeenCalled();
  });
});
