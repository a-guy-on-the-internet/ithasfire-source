import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { declineBookingRequestAct } from "../../booking-requests/answer-booking-request-act";
import { notifyBookingLineupAnswered as notifyBookingLineupAnswered_real } from "../../booking-requests/notify-booking-lineup-answered";
import type {
  AnswerBookingRequestActDeps,
  DeclineBookingRequestActOptions,
} from "../../booking-requests/answer-booking-request-act";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  OTHER_HUMAN_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildStageEventRecord,
  systemEntriesFor,
  withTx,
} from "../../booking-requests/__tests__/helpers";
import { leaveEventLineup, type LeaveEventLineupDeps } from "../leave-event-lineup";
import {
  listBookingLineupSuggestions,
  type ListBookingLineupSuggestionsDeps,
} from "../list-booking-lineup-suggestions";

// ─────────────────────────────────────────────────────────────────────────────
// Owner ruling 2026-09-30, end to end on ONE in-memory store: a tagged act
// who JOINED the bill and was minted onto the show's lineup takes themselves
// off it. Leaving runs the REAL `declineBookingRequestAct` (post-commit, so
// its `on_lineup` gate sees them gone), the act ends DECLINED, and the REAL
// `listBookingLineupSuggestions` no longer offers them to the editor.
// ACTOR_ID is the booking's SENDER (a person); ARTIST is the tagged act.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST = OTHER_HUMAN_ID;
const VENUE_ORG = "19191919-1919-4191-8191-191919191919";
const VENUE_EDITOR = "13131313-1313-4131-8131-131313131313";
/** A band (group sender). VENUE_EDITOR also edits it; BAND_ONLY only it. */
const BAND_ORG = "1a1a1a1a-1a1a-41a1-81a1-1a1a1a1a1a1a";
const BAND_ONLY = "1b1b1b1b-1b1b-41b1-81b1-1b1b1b1b1b1b";
const MEMBERS: Record<string, Array<{ humanId: string; role: string }>> = {
  [VENUE_ORG]: [{ humanId: VENUE_EDITOR, role: "ADMIN" }],
  [BAND_ORG]: [
    { humanId: BAND_ONLY, role: "OWNER" },
    { humanId: VENUE_EDITOR, role: "EDITOR" },
  ],
};

type LineupRow = {
  id: string;
  eventId: string;
  humanId: string | null;
  orgId: string | null;
  externalName: string | null;
  externalUrl: string | null;
  role: string;
  customRoleLabel: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
};

function lineupRow(humanId: string): LineupRow {
  return {
    id: crypto.randomUUID(),
    eventId: EVENT_ID,
    humanId,
    orgId: null,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildWorld(
  options: {
    wirePass?: boolean;
    /** Default: the person ACTOR_ID. */
    sender?: { type: "human" | "organization"; id: string };
    /** Who owns the show (default VENUE_ORG). */
    eventOrgId?: string;
    eventStatus?: EventRecord["status"];
    startsAt?: Date;
    /**
     * Runs after the leave committed and checked the show, right before the
     * REAL pass — the window a cancel / the start time can land in.
     */
    beforePass?: (world: { event: EventRecord; clock: { current: Date } }) => void;
  } = {},
) {
  const request = buildBookingRequestRecord({
    status: "ACCEPTED",
    agreementId: AGREEMENT_ID,
    performerOwnerType: options.sender?.type ?? "human",
    performerOwnerId: options.sender?.id ?? ACTOR_ID,
  });
  const agreement = buildAgreementRecord({ eventId: EVENT_ID });
  const event = buildStageEventRecord({
    id: EVENT_ID,
    status: options.eventStatus ?? "PUBLISHED",
    orgId: options.eventOrgId ?? VENUE_ORG,
    humanId: null,
    title: "Friday Night Sessions",
    visibility: "PUBLIC",
    timezone: "America/Chicago",
    // Upcoming against NOW (2026-06-10) unless a test says otherwise.
    startsAt: options.startsAt ?? new Date("2026-07-10T01:00:00.000Z"),
  } as Partial<EventRecord> & { id: string });

  const lineup: LineupRow[] = [];
  const eventHumans = {
    listByEvent: vi.fn(async (eventId: string) =>
      lineup.filter((row) => row.eventId === eventId),
    ),
    getByEventAndHuman: vi.fn(
      async ({ eventId, humanId }: { eventId: string; humanId: string }) =>
        lineup.find((r) => r.eventId === eventId && r.humanId === humanId) ??
        null,
    ),
    detach: vi.fn(async (id: string) => {
      const i = lineup.findIndex((r) => r.id === id);
      if (i >= 0) lineup.splice(i, 1);
    }),
    attach: vi.fn(),
  };

  const repos = withTx({
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
      findByAgreementId: vi.fn(async (id: string) =>
        id === request.agreementId ? request : null,
      ),
    },
    agreements: {
      getById: vi.fn(async (id: string) => (id === agreement.id ? agreement : null)),
      findByLinkedEventId: vi.fn(async (eventId: string) =>
        agreement.eventId === eventId ? agreement : null,
      ),
    },
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      lockRows: vi.fn(async () => {}),
    },
    eventHumans,
    humans: {
      getById: vi.fn(async (id: string) => ({ id, name: id === ARTIST ? "Artie Artist" : "Sam Sender" })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === ARTIST ? "Artie Artist" : "Sam Sender", status: "ACTIVE" })),
      ),
      getByIdWithIdentity: vi.fn(async () => ({ human: {}, identity: { username: "sam" } })),
    },
    organizations: {
      getById: vi.fn(async (id: string) => ({ id, name: "Some Org", slug: `org-${id.slice(0, 4)}` })),
      getByIds: vi.fn(async () => []),
      listMembers: vi.fn(async ({ orgId }: { orgId: string }) => {
        const items = MEMBERS[orgId] ?? [];
        return { items, total: items.length };
      }),
    },
    entityPages: {
      getByOwner: vi.fn(async () => null),
      getByOwners: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}) },
    volunteering: {
      listSignupsByHuman: vi.fn(async () => []),
      countPendingSignups: vi.fn(async () => 0),
    },
    // Open calls (FR-017): no call covers this event, so no pick to settle.
    eventApplications: { getOpenCall: vi.fn(async () => null) },
    seriesOccurrences: { getCalendarInfoForEventIds: vi.fn(async () => []) },
    authz: {
      getOrgMembership: vi.fn(
        async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
          orgId === VENUE_ORG && humanId === VENUE_EDITOR
            ? { orgId, humanId, role: "ADMIN" }
            : null,
      ),
      getOrgMemberships: vi.fn(async () => []),
    },
  });

  // ONE notify for both notices, as in production (lineup-left rides
  // `notifyWithEmail`, the bill note `notify` — the same pipeline).
  const notify = vi.fn(async () => ({ ok: true, email: { status: "sent" } })) as any;
  const reportError = vi.fn();
  const clockState = { current: NOW };
  const clock = { now: () => clockState.current };
  // The REAL sender notice, so its recipients and the skip are real too.
  const notifyBookingLineupAnswered = vi.fn((args: any) =>
    notifyBookingLineupAnswered_real(
      {
        repos: repos as any,
        notify,
        reportError,
        publicAppUrl: "https://ithasfire.com",
      },
      args,
    ),
  );
  const answerDeps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock,
    notifyBookingLineupAnswered,
    reportError,
  } satisfies AnswerBookingRequestActDeps;

  const leaveDeps: LeaveEventLineupDeps = {
    repos: repos as unknown as LeaveEventLineupDeps["repos"],
    clock,
    logger: createTestLogger(),
    notify,
    publicAppUrl: "https://ithasfire.com",
    reportError,
    ...(options.wirePass === false
      ? {}
      : {
          passBookingRequestAct: (
            input: { actorHumanId: string; bookingRequestId: string },
            passOptions: DeclineBookingRequestActOptions,
          ) => {
            options.beforePass?.({ event, clock: clockState });
            return declineBookingRequestAct(answerDeps, input, passOptions);
          },
        }),
  };
  const suggestionsDeps = {
    repos: repos as unknown as ListBookingLineupSuggestionsDeps["repos"],
    authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
  } as unknown as ListBookingLineupSuggestionsDeps;

  const acts = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];
  return {
    repos,
    acts,
    lineup,
    leaveDeps,
    suggestionsDeps,
    notify,
    notifyBookingLineupAnswered,
    reportError,
  };
}

/** The race tests' common assertions: the booking record was not touched. */
async function expectBookingUntouched(
  world: ReturnType<typeof buildWorld>,
  ledgerBefore: number,
) {
  expect(world.lineup.some((r) => r.humanId === ARTIST)).toBe(false);
  expect(await artistAct(world)).toMatchObject({ confirmation: "CONFIRMED" });
  expect(systemEntriesFor(world.repos, REQUEST_ID)).toHaveLength(ledgerBefore);
  expect((world.repos as any).audit.log).not.toHaveBeenCalledWith(
    expect.objectContaining({ action: "booking_request.act_declined" }),
  );
  expect(world.notifyBookingLineupAnswered).not.toHaveBeenCalled();
  expect(sent(world)).toEqual([["event.lineup-left", VENUE_EDITOR]]);
  expect(world.reportError).not.toHaveBeenCalled();
  expect(world.leaveDeps.logger!.error).not.toHaveBeenCalled();
  expect(world.leaveDeps.logger!.info).toHaveBeenCalledWith(
    "event_humans.lineup_leave_aftermath.booking_act_not_passed",
    { eventId: EVENT_ID, useCase: "leaveEventLineup", race: "event_not_upcoming" },
  );
}

/** SELF (the sender) + ARTIST tagged, ARTIST joined, and minted onto the lineup. */
async function seedJoinedAndMinted(world: ReturnType<typeof buildWorld>) {
  await world.acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: ARTIST, sortOrder: 1, invitedAt: NOW },
  ]);
  await world.acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: ARTIST,
    expectedFrom: "PENDING",
    to: "CONFIRMED",
    respondedAt: NOW,
  });
  world.lineup.push(lineupRow(ACTOR_ID), lineupRow(ARTIST));
}

const artistAct = (world: ReturnType<typeof buildWorld>) =>
  world.acts.getActForOwner({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: ARTIST,
  });

const suggestedHumans = async (world: ReturnType<typeof buildWorld>) =>
  (
    await listBookingLineupSuggestions(world.suggestionsDeps, {
      actorHumanId: VENUE_EDITOR,
      eventId: EVENT_ID,
    })
  ).suggestions.map((s) => s.humanId);

/** [variant, humanId] for every notice sent, sorted. */
const sent = (world: ReturnType<typeof buildWorld>) =>
  world.notify.mock.calls
    .map((c: any) => [c[0].variant, c[0].humanId] as const)
    .sort((a: readonly string[], b: readonly string[]) => (a.join() < b.join() ? -1 : 1));

describe("leaveEventLineup × booking acts (real transition, real suggestions)", () => {
  it("UPCOMING show: a CONFIRMED act leaves → act DECLINED via the transition, never re-suggested", async () => {
    const world = buildWorld();
    await seedJoinedAndMinted(world);
    expect(await suggestedHumans(world)).toEqual([]);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(world.lineup.some((r) => r.humanId === ARTIST)).toBe(false);
    expect(await artistAct(world)).toMatchObject({ confirmation: "DECLINED", respondedAt: NOW });
    // The transition's own side effects: the sender-only ledger entry marks
    // it a LEAVE, and the sender's note says "left".
    expect(
      systemEntriesFor(world.repos, REQUEST_ID).filter(
        (e) => e.systemKind === "booking_request.act_declined",
      ),
    ).toEqual([
      expect.objectContaining({
        systemData: expect.objectContaining({ left: true }),
        authorHumanId: ARTIST,
      }),
    ]);
    expect(world.notifyBookingLineupAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ answer: "left", actorHumanId: ARTIST }),
    );
    // The editor is NOT offered them back.
    expect(await suggestedHumans(world)).toEqual([]);
    // The venue editor gets lineup-left; the sender (a person, sender side
    // ONLY) still gets the bill note; the leaver gets nothing.
    expect(sent(world)).toEqual([
      ["booking.lineup-answered", ACTOR_ID],
      ["event.lineup-left", VENUE_EDITOR],
    ]);
    expect(world.reportError).not.toHaveBeenCalled();
  });

  it("owner ruling: someone on BOTH sides gets the LINEUP notice only; the sender-side-only editor still gets the bill note", async () => {
    // The band sent the request; VENUE_EDITOR edits both the band and the
    // venue org that owns the show; BAND_ONLY edits the band only.
    const world = buildWorld({ sender: { type: "organization", id: BAND_ORG } });
    await seedJoinedAndMinted(world);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(sent(world)).toEqual([
      ["booking.lineup-answered", BAND_ONLY],
      ["event.lineup-left", VENUE_EDITOR],
    ]);
    expect(world.notify.mock.calls.some((c: any) => c[0].humanId === ARTIST)).toBe(false);
    expect(world.reportError).not.toHaveBeenCalled();
  });

  it("requester-owned show: the band's editors ARE the event's editors — each hears once, via lineup-left", async () => {
    const world = buildWorld({
      sender: { type: "organization", id: BAND_ORG },
      eventOrgId: BAND_ORG,
    });
    await seedJoinedAndMinted(world);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(await artistAct(world)).toMatchObject({ confirmation: "DECLINED" });
    expect(sent(world)).toEqual([
      ["event.lineup-left", VENUE_EDITOR],
      ["event.lineup-left", BAND_ONLY],
    ]);
  });

  it("owner ruling: a PAST show is lineup credit only — the act, the ledger and the sender are untouched", async () => {
    const world = buildWorld({ startsAt: new Date("2026-06-01T01:00:00.000Z") });
    await seedJoinedAndMinted(world);
    const before = systemEntriesFor(world.repos, REQUEST_ID).length;

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(world.lineup.some((r) => r.humanId === ARTIST)).toBe(false);
    expect(await artistAct(world)).toMatchObject({ confirmation: "CONFIRMED" });
    expect(systemEntriesFor(world.repos, REQUEST_ID)).toHaveLength(before);
    expect(sent(world)).toEqual([["event.lineup-left", VENUE_EDITOR]]);
    expect(world.reportError).not.toHaveBeenCalled();
  });

  it("owner ruling: a CANCELLED show leaves the booking untouched", async () => {
    const world = buildWorld({ eventStatus: "CANCELLED" });
    await seedJoinedAndMinted(world);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(await artistAct(world)).toMatchObject({ confirmation: "CONFIRMED" });
    expect(world.notifyBookingLineupAnswered).not.toHaveBeenCalled();
  });

  it("happy path takes the event row lock (share) and still passes", async () => {
    const world = buildWorld();
    await seedJoinedAndMinted(world);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect((world.repos as any).events.lockRows).toHaveBeenCalledWith({
      ids: [EVENT_ID],
      mode: "share",
    });
    expect(await artistAct(world)).toMatchObject({ confirmation: "DECLINED" });
    expect(world.reportError).not.toHaveBeenCalled();
  });

  it("race: the show is CANCELLED between the leave's check and the pass → the act is NOT passed, info log, not reported", async () => {
    const world = buildWorld({
      beforePass: ({ event }) => {
        (event as { status: EventRecord["status"] }).status = "CANCELLED";
      },
    });
    await seedJoinedAndMinted(world);
    const before = systemEntriesFor(world.repos, REQUEST_ID).length;

    await expect(
      leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID }),
    ).resolves.toMatchObject({ eventId: EVENT_ID });

    await expectBookingUntouched(world, before);
  });

  it("race: the show is ARCHIVED between the check and the pass → same", async () => {
    const world = buildWorld({
      beforePass: ({ event }) => {
        (event as { status: EventRecord["status"] }).status = "ARCHIVED";
      },
    });
    await seedJoinedAndMinted(world);
    const before = systemEntriesFor(world.repos, REQUEST_ID).length;

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    await expectBookingUntouched(world, before);
  });

  it("race: the show's start time passes between the check and the pass → same", async () => {
    const startsAt = new Date("2026-06-10T12:00:05.000Z"); // 5s after NOW
    const world = buildWorld({
      startsAt,
      beforePass: ({ clock }) => {
        clock.current = startsAt; // startsAt <= now: started
      },
    });
    await seedJoinedAndMinted(world);
    const before = systemEntriesFor(world.repos, REQUEST_ID).length;

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    await expectBookingUntouched(world, before);
  });

  it("negative control: without the pass the same leave WOULD re-suggest them (reported as unwired)", async () => {
    const world = buildWorld({ wirePass: false });
    await seedJoinedAndMinted(world);

    await leaveEventLineup(world.leaveDeps, { actorHumanId: ARTIST, eventId: EVENT_ID });

    expect(await artistAct(world)).toMatchObject({ confirmation: "CONFIRMED" });
    expect(await suggestedHumans(world)).toEqual([ARTIST]);
    expect(world.reportError.mock.calls[0][1].tags.reason).toBe("booking_act_pass_unwired");
  });

  it("hand-attached (not on the bill): leaving changes nothing on the booking", async () => {
    const world = buildWorld();
    await seedJoinedAndMinted(world);
    const STRANGER = "18181818-1818-4181-8181-181818181818";
    world.lineup.push(lineupRow(STRANGER));
    const before = systemEntriesFor(world.repos, REQUEST_ID).length;

    await leaveEventLineup(world.leaveDeps, { actorHumanId: STRANGER, eventId: EVENT_ID });

    expect(await artistAct(world)).toMatchObject({ confirmation: "CONFIRMED" });
    expect(systemEntriesFor(world.repos, REQUEST_ID)).toHaveLength(before);
    expect(world.notifyBookingLineupAnswered).not.toHaveBeenCalled();
    expect(world.reportError).not.toHaveBeenCalled();
  });
});
