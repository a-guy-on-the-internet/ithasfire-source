import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import { ensureEventOnSale } from "../../orders/checkout-helpers";
import { rsvpToEvent } from "../../community/rsvp-to-event";
import { rsvpToEventDate } from "../../community/rsvp-to-event-date";
import { joinEventWaitlist } from "../join-event-waitlist";
import { canViewerReadEvent } from "../_shared/event-public-readability";

// Ban that sticks, review round 1:
//  - nothing new is sold, RSVP'd or wait-listed for a banned owner's event
//    (it answers like an unpublished / missing one), and the events are read
//    WITH the opt-in owner standing;
//  - people who already hold an active ticket keep the event's page.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLDER_ID = "22222222-2222-4222-8222-222222222222";
const STRANGER_ID = "33333333-3333-4333-8333-333333333333";
const DATE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-29T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: "55555555-5555-4555-8555-555555555555",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    stewardship: "OWNED",
    attendanceMode: "RSVP",
    publishedAt: new Date("2026-09-01T00:00:00.000Z"),
    startsAt: new Date("2026-10-10T20:00:00.000Z"),
    endsAt: new Date("2026-10-10T23:00:00.000Z"),
    waitlistStatus: "OPEN",
    waitlistPublishAt: null,
    ownerBanned: true,
    ...overrides,
  } as EventRecord;
}

describe("banned owner: nothing new is sold, RSVP'd or wait-listed", () => {
  it("checkout (ensureEventOnSale) refuses it exactly like an unpublished event", async () => {
    const getById = vi.fn(async () => makeEvent());
    await expect(
      ensureEventOnSale(
        { events: { getById } } as unknown as Parameters<
          typeof ensureEventOnSale
        >[0],
        EVENT_ID,
        NOW,
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
    expect(getById).toHaveBeenCalledWith(EVENT_ID, { withOwnerStanding: true });

    // Control: the same event with an un-banned owner is on sale.
    getById.mockResolvedValueOnce(makeEvent({ ownerBanned: false }));
    await expect(
      ensureEventOnSale(
        { events: { getById } } as unknown as Parameters<
          typeof ensureEventOnSale
        >[0],
        EVENT_ID,
        NOW,
      ),
    ).resolves.toMatchObject({ id: EVENT_ID });
  });

  it("event RSVP refuses it like an unpublished event, writing nothing", async () => {
    const upsert = vi.fn();
    const deps = {
      repos: {
        events: { getById: vi.fn(async () => makeEvent()) },
        eventRsvps: { upsert },
      },
      clock: { now: () => NOW },
    } as unknown as Parameters<typeof rsvpToEvent>[0];
    await expect(
      rsvpToEvent(deps, { actorHumanId: STRANGER_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("date RSVP refuses it like an unpublished event, writing nothing", async () => {
    const upsert = vi.fn();
    const deps = {
      repos: {
        eventDates: {
          getById: vi.fn(async () => ({ id: DATE_ID, eventId: EVENT_ID })),
        },
        events: { getById: vi.fn(async () => makeEvent()) },
        eventDateRsvps: { upsert },
      },
      clock: { now: () => NOW },
    } as unknown as Parameters<typeof rsvpToEventDate>[0];
    await expect(
      rsvpToEventDate(deps, {
        actorHumanId: STRANGER_ID,
        eventDateId: DATE_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("waitlist join answers like a missing event", async () => {
    const deps = {
      repos: { events: { getById: vi.fn(async () => makeEvent()) } },
      clock: { now: () => NOW },
    } as unknown as Parameters<typeof joinEventWaitlist>[0];
    await expect(
      joinEventWaitlist(deps, {
        eventId: EVENT_ID,
        viewerHumanId: STRANGER_ID,
        contactEmail: "fan@example.com",
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

describe("banned owner: existing ticket holders keep the page", () => {
  const authz = {
    getOrgMembership: vi.fn(async () => null),
    getHumanDelegation: vi.fn(async () => null),
    getStaffRolesForHumanId: vi.fn(async () => []),
  } as unknown as Parameters<typeof canViewerReadEvent>[0];
  const tickets = {
    viewerHoldsActiveTicketForEvent: vi.fn(
      async (_eventId: string, humanId: string) => humanId === HOLDER_ID,
    ),
  };
  // No viewer here holds a staff role.
  const staff = { hasStaffRole: async () => ({ allowed: false }) };

  it("a holder of an active ticket can read it", async () => {
    await expect(
      canViewerReadEvent(authz, makeEvent(), HOLDER_ID, tickets, staff),
    ).resolves.toBe(true);
    expect(tickets.viewerHoldsActiveTicketForEvent).toHaveBeenCalledWith(
      EVENT_ID,
      HOLDER_ID,
    );
  });

  it("nobody else can: a stranger, an anonymous viewer, or a holder without the lookup", async () => {
    await expect(
      canViewerReadEvent(authz, makeEvent(), STRANGER_ID, tickets, staff),
    ).resolves.toBe(false);
    await expect(
      canViewerReadEvent(authz, makeEvent(), null, tickets, staff),
    ).resolves.toBe(false);
    await expect(
      canViewerReadEvent(authz, makeEvent(), HOLDER_ID, undefined, staff),
    ).resolves.toBe(false);
  });

  it("the exception covers ONLY the ban: a holder of a DRAFT still cannot read it", async () => {
    await expect(
      canViewerReadEvent(
        authz,
        makeEvent({ status: "DRAFT", publishedAt: null }),
        HOLDER_ID,
        tickets,
        staff,
      ),
    ).resolves.toBe(false);
  });
});
