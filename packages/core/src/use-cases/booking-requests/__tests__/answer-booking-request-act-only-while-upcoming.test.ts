import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import {
  ACT_EVENT_NOT_UPCOMING_REASON,
  declineBookingRequestAct,
  passBookingRequestAct,
  type AnswerBookingRequestActDeps,
} from "../answer-booking-request-act";
import {
  ACTOR_ID,
  EVENT_ID,
  NOW,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildStageEventRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// `onlyWhileEventUpcoming` (owner ruling 2026-10-01): a lineup leave passes
// the act ONLY for an upcoming, live show. The leave checks its own
// snapshot; the pass re-judges the named event in its own transaction —
// event row lock (share), THEN the bill lock, then the re-read — so a show
// cancelled, archived or started in between keeps its booking record
// untouched. The DEFAULT (option absent) reads no event and locks no row.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST = OTHER_HUMAN_ID;
const UPCOMING = new Date("2026-07-10T01:00:00.000Z");

async function buildDeps(
  eventOverrides: Partial<EventRecord> | null = {},
  hooks: {
    /** Runs while the row lock is being granted — a cancel committing first. */
    onLockRows?: (event: EventRecord | null) => void;
  } = {},
) {
  const request = buildBookingRequestRecord({
    performerOwnerType: "human",
    performerOwnerId: ACTOR_ID,
  });
  const event =
    eventOverrides === null
      ? null
      : buildStageEventRecord({
          id: EVENT_ID,
          status: "PUBLISHED",
          startsAt: UPCOMING,
          ...eventOverrides,
        });
  const calls: string[] = [];
  const events = {
    getById: vi.fn(async (id: string) => {
      calls.push("events.getById");
      return id === EVENT_ID ? event : null;
    }),
    lockRows: vi.fn(async (_input: { ids: string[]; mode: string }) => {
      calls.push("events.lockRows");
      hooks.onLockRows?.(event);
    }),
  };
  const repos = withTx({
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    },
    agreements: { getById: vi.fn(async () => null) },
    events,
    eventHumans: { listByEvent: vi.fn(async () => []), attach: vi.fn() },
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === ARTIST ? "Artie Artist" : "Sam Sender", status: "ACTIVE" })),
      ),
      getByIdWithIdentity: vi.fn(async () => null),
    },
    organizations: {
      getById: vi.fn(async () => null),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    entityPages: {
      getByOwner: vi.fn(async () => null),
      getByOwners: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}) },
    authz: { getOrgMembership: vi.fn(async () => null) },
  });
  const acts = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST, sortOrder: 1, invitedAt: NOW },
  ]);
  const realLockBill = acts.lockBill.bind(acts);
  (acts as { lockBill: typeof acts.lockBill }).lockBill = vi.fn(async (id: string) => {
    calls.push("bookingRequests.lockBill");
    return realLockBill(id);
  });
  const notifyBookingLineupAnswered = vi.fn(async (_args: any) => {});
  const deps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock: { now: () => NOW },
    notifyBookingLineupAnswered,
  } satisfies AnswerBookingRequestActDeps;
  const artistAct = () =>
    acts.getActForOwner({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: ARTIST,
    });
  return { deps, repos, events, calls, notifyBookingLineupAnswered, artistAct };
}

const input = { actorHumanId: ARTIST, bookingRequestId: REQUEST_ID };
const guarded = { onlyWhileEventUpcoming: { eventId: EVENT_ID } };

describe("passBookingRequestAct — onlyWhileEventUpcoming", () => {
  it("option ABSENT: today's behaviour — no event read, no row lock, passes even on a cancelled show", async () => {
    for (const options of [undefined, {}, { skipSenderNoticeFor: [] }]) {
      const h = await buildDeps({ status: "CANCELLED" });
      const out = await declineBookingRequestAct(h.deps, input, options);
      expect(out).toMatchObject({ confirmation: "DECLINED", changed: true });
      expect(h.events.getById).not.toHaveBeenCalled();
      expect(h.events.lockRows).not.toHaveBeenCalled();
      expect(h.calls).toEqual(["bookingRequests.lockBill"]);
      expect(h.notifyBookingLineupAnswered).toHaveBeenCalledTimes(1);
    }
  });

  it("upcoming, live show: passes; the event row is share-locked BEFORE the bill lock", async () => {
    const h = await buildDeps();
    const out = await passBookingRequestAct(h.deps, input, guarded);
    expect(out).toMatchObject({ confirmation: "DECLINED", changed: true });
    expect(h.events.lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "share" });
    // The re-read happens INSIDE the tx, after BOTH locks — never before.
    expect(h.calls).toEqual([
      "events.lockRows",
      "bookingRequests.lockBill",
      "events.getById",
    ]);
    expect(h.events.getById).toHaveBeenCalledWith(EVENT_ID);
    expect(
      systemEntriesFor(h.repos, REQUEST_ID).filter(
        (e) => e.systemKind === "booking_request.act_declined",
      ),
    ).toHaveLength(1);
    expect(h.notifyBookingLineupAnswered).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["CANCELLED", { status: "CANCELLED" as const }],
    ["ARCHIVED", { status: "ARCHIVED" as const }],
    ["started (startsAt === now)", { startsAt: NOW }],
    ["past", { startsAt: new Date("2026-06-01T00:00:00.000Z") }],
    ["gone (deleted)", null],
  ])("%s show: refuses with event_not_upcoming and writes NOTHING", async (_label, overrides) => {
    const h = await buildDeps(overrides);
    const before = systemEntriesFor(h.repos, REQUEST_ID).length;

    await expect(passBookingRequestAct(h.deps, input, guarded)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: {
        reason: ACT_EVENT_NOT_UPCOMING_REASON,
        bookingRequestId: REQUEST_ID,
        eventId: EVENT_ID,
      },
    });

    expect(await h.artistAct()).toMatchObject({ confirmation: "PENDING", respondedAt: null });
    expect(systemEntriesFor(h.repos, REQUEST_ID)).toHaveLength(before);
    expect((h.repos as any).audit.log).not.toHaveBeenCalled();
    expect(h.notifyBookingLineupAnswered).not.toHaveBeenCalled();
  });

  it("a cancel that commits while we wait for the row lock wins: event_not_upcoming, nothing written", async () => {
    // The show is upcoming when the pass starts; the cancel holds the row
    // (FOR UPDATE) and commits as our share lock is granted. Only a re-read
    // AFTER the lock can see it.
    const h = await buildDeps(
      {},
      {
        onLockRows: (event) => {
          (event as { status: EventRecord["status"] }).status = "CANCELLED";
        },
      },
    );
    const before = systemEntriesFor(h.repos, REQUEST_ID).length;

    await expect(passBookingRequestAct(h.deps, input, guarded)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: ACT_EVENT_NOT_UPCOMING_REASON, eventId: EVENT_ID },
    });

    expect(h.calls).toEqual([
      "events.lockRows",
      "bookingRequests.lockBill",
      "events.getById",
    ]);
    expect(await h.artistAct()).toMatchObject({ confirmation: "PENDING", respondedAt: null });
    expect(systemEntriesFor(h.repos, REQUEST_ID)).toHaveLength(before);
    expect((h.repos as any).audit.log).not.toHaveBeenCalled();
    expect(h.notifyBookingLineupAnswered).not.toHaveBeenCalled();
  });

  it("an act already passed stays an idempotent success, whatever the show's state", async () => {
    const h = await buildDeps({ status: "CANCELLED" });
    await declineBookingRequestAct(h.deps, input);
    h.notifyBookingLineupAnswered.mockClear();

    const out = await passBookingRequestAct(h.deps, input, guarded);
    expect(out).toMatchObject({ confirmation: "DECLINED", changed: false });
    expect(h.notifyBookingLineupAnswered).not.toHaveBeenCalled();
  });

  it("the option cannot ride in on the client input", async () => {
    const h = await buildDeps();
    await expect(
      declineBookingRequestAct(h.deps, { ...input, onlyWhileEventUpcoming: { eventId: EVENT_ID } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
