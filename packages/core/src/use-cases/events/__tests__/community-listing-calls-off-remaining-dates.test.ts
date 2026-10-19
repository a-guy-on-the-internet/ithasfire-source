import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventDateStatus } from "@th/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import { archiveEvent, type ArchiveEventDeps } from "../archive-event";
import { completeEvent, type CompleteEventDeps } from "../complete-event";

/**
 * Cancelling, archiving or completing a recurring COMMUNITY listing calls off
 * its remaining nights, so the people who RSVP'd PER NIGHT (`EventDateRsvp`, not
 * in the event-level change notice's audience) each get a DATE_CANCELLED
 * notice. Past nights and already-cancelled nights are left alone; OWNED
 * events are not touched.
 */

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ADMIN_ID = "30000000-0000-4000-8000-000000000003";
const ORG_ADMIN_ID = "30000000-0000-4000-8000-000000000004";
const RSVPER_A = "30000000-0000-4000-8000-00000000000a";
const RSVPER_B = "30000000-0000-4000-8000-00000000000b";
const RSVPER_PAST = "30000000-0000-4000-8000-00000000000c";
const RSVPER_EARLIER = "30000000-0000-4000-8000-00000000000d";
const NOW = new Date("2026-07-01T12:00:00.000Z");

const PAST_NIGHT = "date-past";
const NEXT_NIGHT = "date-next";
const LATER_NIGHT = "date-later";
const CALLED_OFF_NIGHT = "date-called-off";

type FakeDate = {
  id: string;
  eventId: string;
  ordinal: number;
  startsAt: Date;
  endsAt: Date | null;
  status: EventDateStatus;
  createdAt: Date;
  updatedAt: Date;
};

function night(
  id: string,
  ordinal: number,
  iso: string,
  status: EventDateStatus = "SCHEDULED",
): FakeDate {
  return {
    id,
    eventId: EVENT_ID,
    ordinal,
    startsAt: new Date(iso),
    endsAt: null,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * A weekly listing: one night already happened, two ahead (the next with two
 * per-night RSVPs), and one ahead that a moderator already called off.
 */
function weeklyListing(): FakeDate[] {
  return [
    night(PAST_NIGHT, 0, "2026-06-24T19:00:00.000Z"),
    night(NEXT_NIGHT, 1, "2026-07-08T19:00:00.000Z"),
    night(LATER_NIGHT, 2, "2026-07-15T19:00:00.000Z"),
    night(CALLED_OFF_NIGHT, 3, "2026-07-22T19:00:00.000Z", "CANCELLED"),
  ];
}

function makeDateFakes(options: {
  dates: FakeDate[];
  /** Night ids whose CAS loses (another transaction moved them first). */
  losesCas?: string[];
  /** Per-night RSVPers; defaults to the weekly listing's. */
  rsvps?: Record<string, string[]>;
  /** Savers and event-level RSVPers (the event-change audience). */
  savers?: string[];
  eventRsvpers?: string[];
}) {
  const store = options.dates;
  const rsvpsByDate: Record<string, string[]> = options.rsvps ?? {
    [PAST_NIGHT]: [RSVPER_PAST],
    [NEXT_NIGHT]: [RSVPER_A, RSVPER_B],
    [LATER_NIGHT]: [],
    [CALLED_OFF_NIGHT]: [RSVPER_EARLIER],
  };
  const notices: Array<{
    eventId: string;
    eventDateId: string;
    humanId: string;
  }> = [];

  const eventDates = {
    listByEvent: vi.fn(
      async (input: {
        eventId: string;
        from?: Date;
        statuses?: EventDateStatus[];
        limit?: number;
      }) =>
        store
          .filter((d) => d.eventId === input.eventId)
          .filter((d) => !input.from || d.startsAt >= input.from)
          .filter((d) => !input.statuses || input.statuses.includes(d.status))
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .slice(0, Math.min(input.limit ?? 100, 500))
          .map((d) => ({ ...d })),
    ),
    markStatusIf: vi.fn(
      async (input: {
        id: string;
        expectStatus: EventDateStatus;
        status: EventDateStatus;
      }) => {
        if (options.losesCas?.includes(input.id)) {
          return { updated: false };
        }
        const row = store.find((d) => d.id === input.id);
        if (!row || row.status !== input.expectStatus) {
          return { updated: false };
        }
        row.status = input.status;
        return { updated: true };
      },
    ),
  };
  const eventDateRsvps = {
    listHumanIdsForDate: vi.fn(async (id: string) => rsvpsByDate[id] ?? []),
  };
  const rsvpNotices = {
    createDateCancelled: vi.fn(
      async (input: {
        eventId: string;
        eventDateId: string;
        humanIds: string[];
      }) => {
        for (const humanId of input.humanIds) {
          notices.push({
            eventId: input.eventId,
            eventDateId: input.eventDateId,
            humanId,
          });
        }
        return input.humanIds.length;
      },
    ),
  };

  const statusOf = (id: string) => store.find((d) => d.id === id)?.status;

  const onePage = (ids: string[]) =>
    vi.fn(async () => ({ items: ids, nextCursor: null }));
  const eventSaves = { listHumanIdsForEvent: onePage(options.savers ?? []) };
  const eventRsvps = {
    listHumanIdsForEvent: onePage(options.eventRsvpers ?? []),
  };

  return {
    store,
    notices,
    eventDates,
    eventDateRsvps,
    rsvpNotices,
    eventSaves,
    eventRsvps,
    statusOf,
  };
}

function communityListing(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "PUBLISHED",
    title: "Weekly Open Mic",
    slug: "event/us/austin/weekly-open-mic",
    startsAt: new Date("2026-07-08T19:00:00.000Z"),
    endsAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventRecord;
}

function ownedEvent(): EventRecord {
  return communityListing({
    orgId: ORG_ID,
    stewardship: "OWNED",
    attendanceMode: "TICKETED",
  });
}

// ─── cancelEvent ────────────────────────────────────────────────────────────

function buildCancelDeps(options: {
  event: EventRecord;
  dates: ReturnType<typeof makeDateFakes>;
}) {
  const auditLog = vi.fn(async () => undefined);
  const txRepos = {
    events: {
      getById: vi.fn(async () => options.event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ ...options.event, status: "CANCELLED" })),
    },
    orders: { getById: vi.fn(async () => null) },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    orderItems: { updateStatus: vi.fn(async () => undefined) },
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    eventDates: options.dates.eventDates,
    eventDateRsvps: options.dates.eventDateRsvps,
    rsvpNotices: options.dates.rsvpNotices,
    eventSaves: options.dates.eventSaves,
    eventRsvps: options.dates.eventRsvps,
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    audit: { log: auditLog },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
    authz: {
      getOrgMembership: vi.fn(async () =>
        options.event.orgId
          ? { orgId: options.event.orgId, humanId: ORG_ADMIN_ID, role: "ADMIN" }
          : null,
      ),
      getHumanDelegation: vi.fn(async () => null),
    },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
    orders: {
      ...(txRepos as unknown as { orders: object }).orders,
      listAll: vi.fn(async () => ({ items: [], total: 0 })),
    },
  } as unknown as Repos;

  const deps: CancelEventDeps = {
    repos,
    authz: {
      hasStaffRole: vi.fn(async ({ actorHumanId }: { actorHumanId: string }) => ({
        allowed: actorHumanId === ADMIN_ID,
      })),
    } as CancelEventDeps["authz"],
    payments: {
      refundPaymentIntent: vi.fn(),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
  };

  return { deps, auditLog };
}

function auditDataOf(
  auditLog: ReturnType<typeof vi.fn>,
  action: string,
): Record<string, unknown> | undefined {
  return auditLog.mock.calls
    .map((call) => call[0] as { action: string; data: Record<string, unknown> })
    .find((entry) => entry.action === action)?.data;
}

describe("cancelEvent — a COMMUNITY listing calls off its remaining nights", () => {
  it("calls off both future SCHEDULED nights, leaves the past and already-off nights alone, and tells each per-night RSVPer once", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog } = buildCancelDeps({
      event: communityListing(),
      dates,
    });

    const result = await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0001",
    });

    expect(result.status).toBe("CANCELLED");
    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(PAST_NIGHT)).toBe("SCHEDULED");
    expect(dates.statusOf(CALLED_OFF_NIGHT)).toBe("CANCELLED");
    // The past night was never even asked to move.
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: PAST_NIGHT }),
    );

    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);

    expect(auditDataOf(auditLog, "cancelled")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
      via: "platform_admin",
    });
  });

  it("tells a person with RSVPs on several remaining nights once, on their earliest", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      rsvps: {
        [NEXT_NIGHT]: [RSVPER_A],
        [LATER_NIGHT]: [RSVPER_A, RSVPER_B],
      },
    });
    const { deps, auditLog } = buildCancelDeps({
      event: communityListing(),
      dates,
    });

    await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0005",
    });

    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: LATER_NIGHT, humanId: RSVPER_B },
    ]);
    expect(auditDataOf(auditLog, "cancelled")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
    });
  });

  it("skips a saver or event-level RSVPer: event.cancelled already tells them", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      savers: [RSVPER_A],
    });
    const { deps, auditLog } = buildCancelDeps({
      event: communityListing(),
      dates,
    });

    await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0006",
    });

    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    expect(auditDataOf(auditLog, "cancelled")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 1,
    });
  });

  it("keeps the recipient count off the result (FR-004 going-count)", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps } = buildCancelDeps({ event: communityListing(), dates });

    const result = await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0002",
    });

    expect(result).not.toHaveProperty("notifiedCount");
    expect(result).not.toHaveProperty("datesCalledOff");
  });

  it("a night whose CAS is lost to another transaction gets no notice from this one", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      losesCas: [NEXT_NIGHT],
    });
    const { deps, auditLog } = buildCancelDeps({
      event: communityListing(),
      dates,
    });

    await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0003",
    });

    expect(dates.notices).toEqual([]);
    expect(dates.eventDateRsvps.listHumanIdsForDate).not.toHaveBeenCalledWith(
      NEXT_NIGHT,
    );
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(auditDataOf(auditLog, "cancelled")).toMatchObject({
      datesCalledOff: 1,
      notifiedCount: 0,
    });
  });

  it("an OWNED event's dates are not touched", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog } = buildCancelDeps({ event: ownedEvent(), dates });

    await cancelEvent(deps, {
      actorHumanId: ORG_ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "call-off-cancel-0004",
    });

    expect(dates.eventDates.listByEvent).not.toHaveBeenCalled();
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([]);
    expect(dates.statusOf(NEXT_NIGHT)).toBe("SCHEDULED");
    const data = auditDataOf(auditLog, "cancelled");
    expect(data).not.toHaveProperty("datesCalledOff");
    expect(data).not.toHaveProperty("notifiedCount");
  });
});

// ─── archiveEvent ───────────────────────────────────────────────────────────

function buildArchiveDeps(options: {
  event: EventRecord;
  dates: ReturnType<typeof makeDateFakes>;
}) {
  const auditLog = vi.fn(async () => undefined);
  const events = {
    lockRows: vi.fn(async () => undefined),
    getById: vi.fn(async () => options.event),
    archive: vi.fn(async () => ({ ...options.event, status: "ARCHIVED" })),
  };
  const eventChangeNotices = { create: vi.fn(async () => undefined) };
  const tx = {
    events,
    audit: { log: auditLog },
    eventChangeNotices,
    eventDates: options.dates.eventDates,
    eventDateRsvps: options.dates.eventDateRsvps,
    rsvpNotices: options.dates.rsvpNotices,
    eventSaves: options.dates.eventSaves,
    eventRsvps: options.dates.eventRsvps,
  } as unknown as TxRepos;
  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    events,
    authz: {
      getOrgMembership: vi.fn(async () =>
        options.event.orgId
          ? { orgId: options.event.orgId, humanId: ORG_ADMIN_ID, role: "ADMIN" }
          : null,
      ),
      getHumanDelegation: vi.fn(async () => null),
    },
  } as unknown as Repos;

  const deps: ArchiveEventDeps = {
    repos,
    authz: {
      hasStaffRole: vi.fn(async ({ actorHumanId }: { actorHumanId: string }) => ({
        allowed: actorHumanId === ADMIN_ID,
      })),
    } as ArchiveEventDeps["authz"],
    clock: { now: () => NOW },
  };

  return { deps, auditLog, eventChangeNotices };
}

describe("archiveEvent — a COMMUNITY listing calls off its remaining nights", () => {
  it("archiving a PUBLISHED listing calls off the future nights and tells their RSVPers once", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog, eventChangeNotices } = buildArchiveDeps({
      event: communityListing(),
      dates,
    });

    const result = await archiveEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, status: "ARCHIVED" });
    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(PAST_NIGHT)).toBe("SCHEDULED");
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    // Owner ruling 2026-10-16: archiving a live listing tells everyone it is
    // CANCELLED, so the event-level notice is cancel's kind, not ARCHIVED.
    expect(eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(eventChangeNotices.create).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "CANCELLED" }),
    );
    expect(auditDataOf(auditLog, "archived")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
      via: "platform_admin",
    });
  });

  it("archiving a PUBLISHED listing skips a saver or event-level RSVPer who holds nights: event.cancelled already tells them", async () => {
    // RSVPER_A saved the listing and holds a night; RSVPER_B holds a night
    // only. Each hears it once: A through event.cancelled, B through the
    // per-night notice.
    const dates = makeDateFakes({
      dates: weeklyListing(),
      savers: [RSVPER_A],
    });
    const { deps, auditLog, eventChangeNotices } = buildArchiveDeps({
      event: communityListing(),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    expect(eventChangeNotices.create).toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "CANCELLED" }),
    );
    expect(eventChangeNotices.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ changeType: "ARCHIVED" }),
    );
    expect(auditDataOf(auditLog, "archived")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 1,
    });
  });

  it("archiving a PUBLISHED listing skips an event-level RSVPer who holds nights too", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      eventRsvpers: [RSVPER_B],
    });
    const { deps } = buildArchiveDeps({ event: communityListing(), dates });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
    ]);
  });

  it("archiving a CANCELLED listing writes no change notice and still tells a saver who holds a legacy night", async () => {
    // No event-level notice on this path (cancel told the savers), so the
    // per-night notice is the only one; the skip must not apply.
    const dates = makeDateFakes({
      dates: weeklyListing(),
      savers: [RSVPER_A],
      eventRsvpers: [RSVPER_B],
    });
    const { deps, eventChangeNotices } = buildArchiveDeps({
      event: communityListing({ status: "CANCELLED" }),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(eventChangeNotices.create).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    expect(dates.eventSaves.listHumanIdsForEvent).not.toHaveBeenCalled();
  });

  it("archiving a COMPLETED listing writes no change notice and tells every RSVPer of a night still ahead", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      savers: [RSVPER_A],
    });
    const { deps, eventChangeNotices } = buildArchiveDeps({
      event: communityListing({ status: "COMPLETED" }),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(eventChangeNotices.create).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
  });

  it("archiving a listing CANCELLED before cancel called nights off calls off the nights it left SCHEDULED", async () => {
    // A cancel from before this change flipped the listing and nothing else:
    // its future nights are still SCHEDULED and their people were never told.
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog } = buildArchiveDeps({
      event: communityListing({ status: "CANCELLED" }),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(PAST_NIGHT)).toBe("SCHEDULED");
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    expect(auditDataOf(auditLog, "archived")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
    });
  });

  it("archiving a listing whose cancel already called its nights off tells nobody twice", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing().map((d) =>
        d.id === PAST_NIGHT ? d : { ...d, status: "CANCELLED" as const },
      ),
    });
    const { deps, auditLog } = buildArchiveDeps({
      event: communityListing({ status: "CANCELLED" }),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([]);
    expect(auditDataOf(auditLog, "archived")).toMatchObject({
      datesCalledOff: 0,
      notifiedCount: 0,
    });
  });

  it("an OWNED event's dates are not touched, and its notice stays ARCHIVED (event.unlisted)", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog, eventChangeNotices } = buildArchiveDeps({
      event: ownedEvent(),
      dates,
    });

    await archiveEvent(deps, { actorHumanId: ORG_ADMIN_ID, eventId: EVENT_ID });

    expect(eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(eventChangeNotices.create).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "ARCHIVED",
      payload: { eventTitle: "Weekly Open Mic" },
    });

    expect(dates.eventDates.listByEvent).not.toHaveBeenCalled();
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([]);
    expect(auditDataOf(auditLog, "archived")).not.toHaveProperty(
      "notifiedCount",
    );
  });
});

// ─── completeEvent ──────────────────────────────────────────────────────────

function buildCompleteDeps(options: {
  event: EventRecord;
  dates: ReturnType<typeof makeDateFakes>;
}) {
  const auditLog = vi.fn(async () => undefined);
  const events = {
    lockRows: vi.fn(async () => undefined),
    getById: vi.fn(async (_id: string): Promise<EventRecord | null> => options.event),
    complete: vi.fn(async () => ({ ...options.event, status: "COMPLETED" })),
  };
  const eventChangeNotices = { create: vi.fn(async () => undefined) };
  const tx = {
    events,
    audit: { log: auditLog },
    eventChangeNotices,
    eventDates: options.dates.eventDates,
    eventDateRsvps: options.dates.eventDateRsvps,
    rsvpNotices: options.dates.rsvpNotices,
    eventSaves: options.dates.eventSaves,
    eventRsvps: options.dates.eventRsvps,
    // holds-without-a-request: complete releases the event's request-less nights.
    bookingHolds: { listConfirmedRequestlessForEvent: vi.fn(async () => []) },
    // Booking timeline: no agreement linked, so the ledger stays silent.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;
  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    events,
    authz: {
      getOrgMembership: vi.fn(async () =>
        options.event.orgId
          ? { orgId: options.event.orgId, humanId: ORG_ADMIN_ID, role: "ADMIN" }
          : null,
      ),
      getHumanDelegation: vi.fn(async () => null),
    },
  } as unknown as Repos;

  const deps: CompleteEventDeps = {
    repos,
    authz: {
      hasStaffRole: vi.fn(async ({ actorHumanId }: { actorHumanId: string }) => ({
        allowed: actorHumanId === ADMIN_ID,
      })),
    } as CompleteEventDeps["authz"],
    clock: { now: () => NOW },
  };

  return { deps, auditLog, eventChangeNotices, events };
}

describe("completeEvent — a COMMUNITY listing calls off its remaining nights (owner ruling 2026-10-16, Q5)", () => {
  it("calls off the future SCHEDULED nights, leaves the past and already-off nights alone, and tells each per-night RSVPer once", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog, eventChangeNotices } = buildCompleteDeps({
      event: communityListing(),
      dates,
    });

    const result = await completeEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, status: "COMPLETED" });
    expect(dates.statusOf(NEXT_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(LATER_NIGHT)).toBe("CANCELLED");
    expect(dates.statusOf(PAST_NIGHT)).toBe("SCHEDULED");
    // CALLED_OFF_NIGHT was already off: no second CAS, no second notice.
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: CALLED_OFF_NIGHT }),
    );
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: PAST_NIGHT }),
    );
    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    // Complete writes no event-level change notice.
    expect(eventChangeNotices.create).not.toHaveBeenCalled();
    expect(auditDataOf(auditLog, "completed")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
      via: "platform_admin",
    });
  });

  it("tells a person with RSVPs on several remaining nights once, on their earliest", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      rsvps: {
        [NEXT_NIGHT]: [RSVPER_A],
        [LATER_NIGHT]: [RSVPER_A, RSVPER_B],
      },
    });
    const { deps, auditLog } = buildCompleteDeps({
      event: communityListing(),
      dates,
    });

    await completeEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: LATER_NIGHT, humanId: RSVPER_B },
    ]);
    expect(auditDataOf(auditLog, "completed")).toMatchObject({
      datesCalledOff: 2,
      notifiedCount: 2,
    });
  });

  it("does not skip a saver or event-level RSVPer who holds nights: complete sends them nothing else", async () => {
    const dates = makeDateFakes({
      dates: weeklyListing(),
      savers: [RSVPER_A],
      eventRsvpers: [RSVPER_B],
    });
    const { deps } = buildCompleteDeps({ event: communityListing(), dates });

    await completeEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.notices).toEqual([
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_A },
      { eventId: EVENT_ID, eventDateId: NEXT_NIGHT, humanId: RSVPER_B },
    ]);
    expect(dates.eventSaves.listHumanIdsForEvent).not.toHaveBeenCalled();
    expect(dates.eventRsvps.listHumanIdsForEvent).not.toHaveBeenCalled();
  });

  it("keeps the recipient count off the result (FR-004 going-count)", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps } = buildCompleteDeps({ event: communityListing(), dates });

    const result = await completeEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
    });

    expect(result).not.toHaveProperty("notifiedCount");
    expect(result).not.toHaveProperty("datesCalledOff");
  });

  it("a listing completed after its last night calls nothing off and tells nobody", async () => {
    const dates = makeDateFakes({
      dates: [night(PAST_NIGHT, 0, "2026-06-24T19:00:00.000Z")],
    });
    const { deps, auditLog } = buildCompleteDeps({
      event: communityListing(),
      dates,
    });

    await completeEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID });

    expect(dates.statusOf(PAST_NIGHT)).toBe("SCHEDULED");
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([]);
    expect(auditDataOf(auditLog, "completed")).toMatchObject({
      datesCalledOff: 0,
      notifiedCount: 0,
    });
  });

  it("a completion that loses the race to another one refuses under the lock and calls nothing off", async () => {
    // The pre-tx read saw PUBLISHED; by the time this transaction holds the
    // row lock, a concurrent completion has committed.
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog, events } = buildCompleteDeps({
      event: communityListing(),
      dates,
    });
    events.getById
      .mockResolvedValueOnce(communityListing())
      .mockResolvedValue(communityListing({ status: "COMPLETED" }));

    await expect(
      completeEvent(deps, { actorHumanId: ADMIN_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_COMPLETED" });

    expect(events.lockRows).toHaveBeenCalledWith({
      ids: [EVENT_ID],
      mode: "update",
    });
    expect(events.complete).not.toHaveBeenCalled();
    expect(dates.eventDates.listByEvent).not.toHaveBeenCalled();
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.notices).toEqual([]);
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("an OWNED event's dates are not touched", async () => {
    const dates = makeDateFakes({ dates: weeklyListing() });
    const { deps, auditLog, eventChangeNotices } = buildCompleteDeps({
      event: ownedEvent(),
      dates,
    });

    await completeEvent(deps, { actorHumanId: ORG_ADMIN_ID, eventId: EVENT_ID });

    expect(dates.eventDates.listByEvent).not.toHaveBeenCalled();
    expect(dates.eventDates.markStatusIf).not.toHaveBeenCalled();
    expect(dates.statusOf(NEXT_NIGHT)).toBe("SCHEDULED");
    expect(dates.notices).toEqual([]);
    expect(eventChangeNotices.create).not.toHaveBeenCalled();
    const data = auditDataOf(auditLog, "completed");
    expect(data).not.toHaveProperty("datesCalledOff");
    expect(data).not.toHaveProperty("notifiedCount");
  });
});
